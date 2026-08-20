/**
 * A count of tokens, distinct from a bare `number`.
 *
 * Token counts arrive from two untrusted sources — the user's settings file
 * and Pi's context-usage estimate — and both surface as plain `number`s.
 * Branding the *resolved* threshold means only validated input can ever be
 * compared against the budget; nothing raw from a JSON file flows into a
 * decision without passing the validator in {@link toTokenCount}.
 */
export type TokenCount = number & { readonly __brand: "TokenCount" };

/**
 * The one place an untrusted value becomes a `TokenCount`: validates that it
 * is a positive integer, returns `null` when it is not. `shouldCompact` only
 * ever compares branded counts against each other, so nothing raw from JSON
 * can reach a decision without passing through here.
 */
export function toTokenCount(value: unknown): TokenCount | null {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		return null;
	}
	return value as TokenCount;
}

/**
 * The user-facing configuration section read from `settings.json`.
 *
 * Every field is optional and untrusted: it is parsed from JSON and may hold
 * anything. {@link parseConfig} narrows it into a {@link ResolvedPolicy},
 * falling back per field instead of failing the load.
 */
export interface CompactionThresholdConfig {
  /** Master switch; defaults to `true`. */
  enabled?: unknown;
  /**
   * Token ceiling at which to compact. Defaults to
   * `DEFAULT_THRESHOLD_TOKENS` when absent or invalid.
   */
  tokens?: unknown;
  /**
   * Whether to send an automatic "continue" turn after compaction so
   * long-running autonomous work picks up where it left off. Defaults to
   * `true`. This is a new turn, not a true resumption of the interrupted
   * one — Pi exposes no continuation handle to extensions — but the model
   * continues from the summary plus recent context.
   */
  autoResume?: unknown;
}

/**
 * A validated, complete compaction policy.
 *
 * The ceiling is deliberately **absolute**, not relative to the model's
 * context window: the point of this extension is to compact *before* Pi's own
 * window-relative overflow threshold would fire, so the decision must not
 * move when the active model changes. On small-window models the ceiling is
 * simply never reached — Pi's native overflow protection still fires first.
 */
export interface ResolvedPolicy {
  readonly enabled: boolean;
  readonly thresholdTokens: TokenCount;
  /** See {@link CompactionThresholdConfig.autoResume}. */
  readonly autoResume: boolean;
}

/** The result of reading and validating the user's configuration. */
export interface LoadedConfig {
  readonly policy: ResolvedPolicy;
  /**
   * Problems found while reading or validating settings, each phrased for a
   * user-facing notification. Empty in the normal case.
   */
  readonly warnings: string[];
}
