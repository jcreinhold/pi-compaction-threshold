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

	// `turn_end` is the stable point to decide: the previous turn is complete,
	// so compaction's context rebuild cannot race an in-flight request.
	pi.on("turn_end", (_event, ctx) => {
		if (compacting) return;
		if (loaded === undefined) return; // no session_start yet — stay conservative

		const { policy } = loaded;
		if (!policy.enabled) return;

		const usage = ctx.getContextUsage();
		if (usage === undefined) return; // no usage estimate for this turn
		const { tokens } = usage;
		// Unknown count (right after a compaction) means "no decision",
		// not "compact" — handle it here, before the type-safe comparison.
		if (tokens === null) return;
		if (!shouldCompact(tokens, policy)) return;

		compacting = true;
		notify(ctx, `Context at ${tokens.toLocaleString()} tokens; compacting above threshold ${policy.thresholdTokens.toLocaleString()}.`);

		ctx.compact({
			onComplete: () => {
				compacting = false;
				notify(ctx, "Compaction completed.");
			},
			onError: (error) => {
				compacting = false;
				notify(ctx, `Compaction failed: ${error.message}`, "error");
			},
		});
	});
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	}
}
