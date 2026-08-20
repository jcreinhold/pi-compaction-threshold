import { toTokenCount, type ResolvedPolicy, type TokenCount } from "./types";

/**
 * The ceiling used when the user has not configured one. It is a default, not
 * a hardcode: any `compactionThreshold.tokens` in settings.json overrides it.
 */
export const DEFAULT_THRESHOLD_TOKENS = 250_000;

/**
 * Pi's own `compaction.keepRecentTokens` setting, used only to warn when the
 * configured ceiling can never settle (see `loadConfig`).
 */
export const DEFAULT_KEEP_RECENT_TOKENS = defaultTokenCount(20_000);

export const DEFAULT_POLICY: ResolvedPolicy = {
	enabled: true,
	thresholdTokens: defaultTokenCount(DEFAULT_THRESHOLD_TOKENS),
	autoResume: true,
};

/**
 * Validate a compile-time-known constant and fail loudly if it ever stops
 * being a valid token count — a bug in this module, not a user-input error.
 * Ensures the defaults never carry `null`; cast-free by construction.
 */
function defaultTokenCount(value: number): TokenCount {
	const parsed = toTokenCount(value);
	if (parsed === null) {
		throw new Error(`internal default token count is invalid: ${value}`);
	}
	return parsed;
}
