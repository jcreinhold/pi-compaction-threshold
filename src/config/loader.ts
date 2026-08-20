import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_KEEP_RECENT_TOKENS, DEFAULT_POLICY } from "./defaults";
import { toTokenCount, type LoadedConfig, type TokenCount } from "./types";

/**
 * The section of `settings.json` this extension owns. It sits beside Pi's own
 * `compaction` block so the two thresholds read as siblings.
 */
const SETTINGS_KEY = "compactionThreshold" as const;

export interface LoadConfigOptions {
	/**
	 * Whether the current project is trusted. `.pi/settings.json` is only
	 * consulted when true — the same gate Pi itself applies to project
	 * settings — so an untrusted project can never inject a policy.
	 */
	readonly projectTrusted: boolean;
}

/**
 * Validate a raw `compactionThreshold` section into a complete policy.
 *
 * Total by design: `unknown` always yields a `LoadedConfig`, never a throw.
 * Bad fields fall back to defaults and are reported so the operator sees
 * *why* their setting lost (get the problem into the message, not just into
 * worse behavior — the fallback is defined, never silent drift).
 */
export function parseConfig(raw: unknown): LoadedConfig {
	const warnings: string[] = [];
	// Fresh mutable object: bad fields fall back one at a time, then the whole
	// thing is returned as the immutable `ResolvedPolicy`.
	const policy = {
		enabled: DEFAULT_POLICY.enabled,
		thresholdTokens: DEFAULT_POLICY.thresholdTokens,
		autoResume: DEFAULT_POLICY.autoResume,
	};

	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		// `undefined` means "not configured" — the normal case, stay silent.
		if (raw !== undefined) {
			warnings.push(
				`${SETTINGS_KEY} must be a JSON object, got ${describe(raw)}; using defaults.`,
			);
		}
		return { policy, warnings };
	}

	const section = raw as Record<string, unknown>;

	const rawEnabled = section.enabled;
	if (rawEnabled !== undefined) {
		if (typeof rawEnabled === "boolean") {
			policy.enabled = rawEnabled;
		} else {
			warnings.push(
				`${SETTINGS_KEY}.enabled must be a boolean, got ${describe(rawEnabled)}; using default.`,
			);
		}
	}

	const rawTokens = section.tokens;
	if (rawTokens !== undefined) {
		const tokens = toTokenCount(rawTokens);
		if (tokens !== null) {
			policy.thresholdTokens = tokens;
		} else {
			warnings.push(
				`${SETTINGS_KEY}.tokens must be a positive integer, got ${describe(rawTokens)}; using default.`,
			);
		}
	}

	const rawAutoResume = section.autoResume;
	if (rawAutoResume !== undefined) {
		if (typeof rawAutoResume === "boolean") {
			policy.autoResume = rawAutoResume;
		} else {
			warnings.push(
				`${SETTINGS_KEY}.autoResume must be a boolean, got ${describe(rawAutoResume)}; using default.`,
			);
		}
	}

	return { policy, warnings };
}

/**
 * Read the policy from disk: the global `~/.pi/agent/settings.json` always,
 * the project `.pi/settings.json` only when trusted, merged project-over-
 * global exactly as Pi's own settings merge works (nested objects merged
 * field-wise). Returns warnings for anything the operator should see.
 */
export function loadConfig(agentDir: string, cwd: string, options: LoadConfigOptions): LoadedConfig {
	const warnings: string[] = [];

	const globalSection = readSection(join(agentDir, "settings.json"), "global", warnings);
	const projectSection = options.projectTrusted
		? readSection(join(cwd, ".pi", "settings.json"), "project", warnings)
		: {};

	// A project value shadows the global one per field, like Pi's merge.
	const merged = { ...globalSection, ...projectSection };
	const parsed = parseConfig(merged);
	warnings.push(...parsed.warnings);

	// Pathological-config guard: after a compaction Pi keeps `keepRecentTokens`
	// (default 20k) as the un-summarized remainder. A ceiling at or below that
	// means the kept remainder alone re-crosses the ceiling, so every
	// post-compaction turn fires a fresh compaction — a permanent 1-turn loop.
	// Surface it; never clamp silently.
	const keepRecent = readKeepRecentTokens(agentDir, cwd, options.projectTrusted);
	let { policy } = parsed;
	if (policy.enabled && policy.thresholdTokens <= keepRecent) {
		warnings.push(
			`threshold ${policy.thresholdTokens.toLocaleString()} is at or below Pi's ` +
				`compaction.keepRecentTokens (${keepRecent.toLocaleString()}), so compaction would ` +
				`re-trigger after every turn; raise ${SETTINGS_KEY}.tokens.`,
		);
		// With auto-resume, the 1-turn loop becomes a hard runaway: compact,
		// continue, immediately over the ceiling again, compact... Disable it
		// here — a pathological ceiling is already warned about, and resuming
		// turns is what turns the warning into a flameout.
		if (policy.autoResume) {
			policy = { ...policy, autoResume: false };
			warnings.push(
				`${SETTINGS_KEY}.autoResume disabled because the ceiling cannot settle; ` +
					`raise ${SETTINGS_KEY}.tokens above ${keepRecent.toLocaleString()} to re-enable.`,
			);
		}
	}

	return { policy, warnings };
}

type JsonRead =
	| { status: "missing" } // file absent — the normal case, callers stay silent
	| { status: "invalid-json" } // present but unreadable as JSON — callers warn
	| { status: "ok"; value: unknown };

function readJson(filePath: string): JsonRead {
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch {
		return { status: "missing" };
	}
	try {
		return { status: "ok", value: JSON.parse(text) };
	} catch {
		return { status: "invalid-json" };
	}
}

/** The `compactionThreshold` section of one settings file, or `{}` when absent or unusable. */
function readSection(filePath: string, scope: "global" | "project", warnings: string[]): Record<string, unknown> {
	const result = readJson(filePath);
	if (result.status === "ok") {
		const root = result.value;
		if (root === null || typeof root !== "object" || Array.isArray(root)) {
			warnings.push(`${scope} settings file is not a JSON object; ignoring ${SETTINGS_KEY}.`);
			return {};
		}
		const section = (root as Record<string, unknown>)[SETTINGS_KEY];
		if (section === undefined) return {};
		if (section === null || typeof section !== "object" || Array.isArray(section)) {
			warnings.push(
				`${scope} ${SETTINGS_KEY} must be an object, got ${describe(section)}; ignoring.`,
			);
			return {};
		}
		return section as Record<string, unknown>;
	}
	if (result.status === "invalid-json") {
		warnings.push(`${scope} settings file contains invalid JSON; ignoring ${SETTINGS_KEY}.`);
	}
	return {};
}

/**
 * Pi's `compaction.keepRecentTokens` (project over global, default 20k),
 * used only to decide the pathological-config warning above.
 */
function readKeepRecentTokens(agentDir: string, cwd: string, projectTrusted: boolean): TokenCount {
	const global = readNestedTokenCount(join(agentDir, "settings.json"), ["compaction", "keepRecentTokens"]);
	const project = projectTrusted
		? readNestedTokenCount(join(cwd, ".pi", "settings.json"), ["compaction", "keepRecentTokens"])
		: undefined;
	return project ?? global ?? DEFAULT_KEEP_RECENT_TOKENS;
}

/** Walk a nested object path and return the leaf as a TokenCount when it is a positive integer. */
function readNestedTokenCount(filePath: string, path: readonly string[]): TokenCount | undefined {
	const result = readJson(filePath);
	if (result.status !== "ok") return undefined;
	let node: unknown = result.value;
	for (const key of path) {
		if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
		const record = node as Record<string, unknown>;
		// Own-property read only: `JSON.parse` can produce a `__proto__` own
		// property, and the read must never touch the prototype chain.
		if (!Object.hasOwn(record, key)) return undefined;
		node = record[key];
	}
	return toTokenCount(node) ?? undefined;
}

/** Render an arbitrary JSON value for the one place user mistakes surface: the warning. */
function describe(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
