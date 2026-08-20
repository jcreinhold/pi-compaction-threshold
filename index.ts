import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { loadConfig, shouldCompact, type LoadedConfig } from "./src/config";

/**
 * Proactively compact the session once estimated context usage crosses a
 * configurable token ceiling, regardless of the active model's context
 * window. Pi's own auto-compaction is window-relative
 * (`contextTokens > contextWindow - reserveTokens`); this extension fires
 * *earlier* on large-window models by comparing against an absolute ceiling.
 *
 * The ceiling is enforced **mid-turn**, not just at turn boundaries: long
 * autonomous agent loops do most of their work between turn ends, so checking
 * only `turn_end` lets context balloon past the ceiling in the meantime. Each
 * completed unit of work — an ended turn, a finished tool execution, a
 * finished assistant message — is a check point. `ctx.compact()` itself
 * aborts the current agent operation first (Pi's manual-compaction contract),
 * which is what interrupts the turn.
 *
 * Configure in `settings.json` (global or project) under `compactionThreshold`:
 *
 * ```json
 * {
 *   "compactionThreshold": {
 *     "enabled": true,
 *     "tokens": 250000
 *   }
 * }
 * ```
 *
 * Install by symlinking this directory into `~/.pi/agent/extensions/` and
 * running `/reload` (see README).
 */
export default function compactionThresholdExtension(pi: ExtensionAPI) {
	// Loaded once per process at session start; `/reload` re-runs this factory.
	let loaded: LoadedConfig | undefined;
	// Guard against stacking compactions: `ctx.compact` is fire-and-forget, so
	// while one is in flight the next threshold crossing must not start another.
	let compacting = false;

	pi.on("session_start", (_event, ctx) => {
		loaded = loadConfig(getAgentDir(), ctx.cwd, {
			projectTrusted: ctx.isProjectTrusted(),
		});
		if (ctx.hasUI && loaded.warnings.length > 0) {
			ctx.ui.notify(
				["pi-compaction-threshold:", ...loaded.warnings.map((w) => ` - ${w}`)].join("\n"),
				"warning",
			);
		}
	});

	// Single guarded decision shared by every check point.
	const maybeCompact = (ctx: ExtensionContext): void => {
		if (compacting) return;
		if (loaded === undefined) return; // no session_start yet — stay conservative

		const { policy } = loaded;
		if (!policy.enabled) return;

		const usage = ctx.getContextUsage();
		if (usage === undefined) return; // no usage estimate for this point
		const { tokens } = usage;
		// Unknown count (right after a compaction) means "no decision",
		// not "compact" — handle it here, before the type-safe comparison.
		if (tokens === null) return;
		if (!shouldCompact(tokens, policy)) return;

		compacting = true;
		notify(
			ctx,
			`Context at ${tokens.toLocaleString()} tokens; interrupting the turn and compacting above threshold ${policy.thresholdTokens.toLocaleString()}.`,
		);

		ctx.compact({
			onComplete: () => {
				compacting = false;
				if (policy.autoResume) {
					// Automatic continuation: a fresh turn, not a true resumption of
					// the interrupted one (Pi exposes no continuation handle to
					// extensions), but the model picks up from the summary plus recent
					// context exactly where the work stopped.
					pi.sendUserMessage(
						"Continue the previous work. Context was compacted at this point; use the summary above to pick up where you left off.",
					);
					notify(ctx, "Compaction completed; automatically continuing the interrupted work.");
				} else {
					notify(
						ctx,
						"Compaction completed. The turn was interrupted; progress is preserved in the summary — say 'continue' to resume.",
					);
				}
			},
			onError: (error) => {
				compacting = false;
				notify(ctx, `Compaction failed: ${error.message}`, "error");
			},
		});
	};

	// Turn boundary: the earliest complete point for a turn that had no tools.
	pi.on("turn_end", (_event, ctx) => {
		maybeCompact(ctx);
	});

	// Mid-turn, after each tool finishes: long autonomous loops spend most of
	// their context growth here. The tool is already complete when this fires,
	// so aborting the agent afterwards loses no in-flight tool work.
	pi.on("tool_execution_end", (_event, ctx) => {
		maybeCompact(ctx);
	});

	// Mid-turn, after each assistant message completes: catches a single long
	// response that grew the context past the ceiling on its own.
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return; // tool results are covered by tool_execution_end
		maybeCompact(ctx);
	});
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	}
}
