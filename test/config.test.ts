import { describe, expect, it } from "vitest";

import { DEFAULT_POLICY, DEFAULT_THRESHOLD_TOKENS, parseConfig, shouldCompact, toTokenCount } from "../src/config";

describe("parseConfig", () => {
	it("yields the defaults for no configuration", () => {
		const { policy, warnings } = parseConfig(undefined);
		expect(policy).toEqual(DEFAULT_POLICY);
		expect(warnings).toEqual([]);
	});

	it("applies an all-valid section", () => {
		const { policy, warnings } = parseConfig({ enabled: false, tokens: 500_000 });
		expect(policy).toEqual({
			enabled: false,
			thresholdTokens: toTokenCount(500_000),
		});
		expect(warnings).toEqual([]);
	});

	it("falls back per field on invalid values and reports them", () => {
		const { policy, warnings } = parseConfig({ enabled: "yes", tokens: -12 });
		expect(policy).toEqual(DEFAULT_POLICY);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("enabled");
		expect(warnings[1]).toContain("tokens");
	});

	it("treats a non-object section as unset with a warning", () => {
		const { policy, warnings } = parseConfig(42);
		expect(policy).toEqual(DEFAULT_POLICY);
		expect(warnings).toHaveLength(1);
	});

	it("never throws, whatever it is given", () => {
		for (const raw of [null, undefined, "250000", [1, 2], true, { tokens: "many" }]) {
			expect(() => parseConfig(raw)).not.toThrow();
		}
	});
});

describe("toTokenCount", () => {
	it("accepts positive integers", () => {
		expect(toTokenCount(1)).toBe(1);
		expect(toTokenCount(DEFAULT_THRESHOLD_TOKENS)).toBe(DEFAULT_THRESHOLD_TOKENS);
	});

	it("rejects zero, negatives, fractions, and non-numbers", () => {
		for (const raw of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "250000", null]) {
			expect(toTokenCount(raw), `raw=${String(raw)}`).toBeNull();
		}
	});
});

describe("shouldCompact", () => {
	const policy = parseConfig({ tokens: 250_000 }).policy;

	it("triggers at or above the ceiling", () => {
		expect(shouldCompact(250_000, policy)).toBe(true);
		expect(shouldCompact(251_000, policy)).toBe(true);
	});

	it("does not trigger below the ceiling", () => {
		expect(shouldCompact(249_999, policy)).toBe(false);
	});

	// An unknown count (null, right after a compaction) is rejected at the
	// type level: `shouldCompact` takes a non-nullable `number`, so the
	// "no decision, wait" gate lives at the call site in index.ts.
});
