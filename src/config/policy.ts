import type { ResolvedPolicy } from "./types";

/**
 * Whether the current estimated context tokens cross the policy's ceiling.
 *
 * `tokens` is intentionally non-nullable: an unknown count (right after a
 * compaction, before the next LLM response) is a call-site concern — "no
 * decision, wait" — and the type system forces the caller to resolve it
 * before asking. The ceiling itself is absolute rather than window-relative
 * by design: see the rationale on {@link ResolvedPolicy}.
 */
export function shouldCompact(tokens: number, policy: ResolvedPolicy): boolean {
	return tokens >= policy.thresholdTokens;
}
