import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	DEFAULT_POLICY,
	DEFAULT_THRESHOLD_TOKENS,
	loadConfig,
	parseConfig,
	shouldCompact,
	toTokenCount,
} from "../src/config";

describe("parseConfig", () => {
	it("yields the defaults for no configuration", () => {
		const { policy, warnings } = parseConfig(undefined);
		expect(policy).toEqual(DEFAULT_POLICY);
		expect(warnings).toEqual([]);
	});

	it("applies an all-valid section", () => {
		const { policy, warnings } = parseConfig({ enabled: false, tokens: 500_000, autoResume: false });
		expect(policy).toEqual({
			enabled: false,
			thresholdTokens: toTokenCount(500_000),
			autoResume: false,
		});
		expect(warnings).toEqual([]);
	});

	it("falls back per field on invalid values and reports them", () => {
		const { policy, warnings } = parseConfig({ enabled: "yes", tokens: -12, autoResume: "yes" });
		expect(policy).toEqual(DEFAULT_POLICY);
		expect(warnings).toHaveLength(3);
		expect(warnings[0]).toContain("enabled");
		expect(warnings[1]).toContain("tokens");
		expect(warnings[2]).toContain("autoResume");
	});

	it("defaults autoResume to true and accepts an explicit false", () => {
		expect(parseConfig(undefined).policy.autoResume).toBe(true);
		expect(parseConfig({ autoResume: false }).policy.autoResume).toBe(false);
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

describe("loadConfig", () => {
	let dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function makeDirs(): { agentDir: string; cwd: string } {
		const agentDir = mkdtempSync(join(tmpdir(), "pct-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "pct-project-"));
		dirs.push(agentDir, cwd);
		return { agentDir, cwd };
	}

	function writeProjectSettings(cwd: string, settings: unknown): void {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(settings));
	}

	it("yields defaults when no settings files exist", () => {
		const { agentDir, cwd } = makeDirs();
		const { policy, warnings } = loadConfig(agentDir, cwd, { projectTrusted: true });
		expect(policy).toEqual(DEFAULT_POLICY);
		expect(warnings).toEqual([]);
	});

	it("merges project over global per field", () => {
		const { agentDir, cwd } = makeDirs();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ compactionThreshold: { tokens: 200_000 } }),
		);
		writeProjectSettings(cwd, { compactionThreshold: { enabled: false } });
		const { policy, warnings } = loadConfig(agentDir, cwd, { projectTrusted: true });
		expect(policy).toEqual({
			enabled: false,
			thresholdTokens: toTokenCount(200_000),
			autoResume: true,
		});
		expect(warnings).toEqual([]);
	});

	it("ignores project settings when the project is not trusted", () => {
		const { agentDir, cwd } = makeDirs();
		writeProjectSettings(cwd, { compactionThreshold: { tokens: 10_000 } });
		const { policy } = loadConfig(agentDir, cwd, { projectTrusted: false });
		expect(policy).toEqual(DEFAULT_POLICY);
	});

	it("forces autoResume off when the ceiling cannot settle", () => {
		const { agentDir, cwd } = makeDirs();
		// Ceiling below Pi's default keepRecentTokens (20k): the kept remainder
		// alone re-crosses the ceiling, so compact→continue would spin forever.
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ compactionThreshold: { tokens: 10_000 } }),
		);
		const { policy, warnings } = loadConfig(agentDir, cwd, { projectTrusted: true });
		expect(policy.autoResume).toBe(false);
		expect(warnings.some((w) => w.includes("keepRecentTokens"))).toBe(true);
		expect(warnings.some((w) => w.includes("autoResume disabled"))).toBe(true);
	});

	it("uses a project keepRecentTokens override when judging the ceiling", () => {
		const { agentDir, cwd } = makeDirs();
		// Global ceiling is fine against the default 20k...
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ compactionThreshold: { tokens: 25_000 } }),
		);
		// ...but the project raises keepRecentTokens above it → pathological.
		writeProjectSettings(cwd, { compaction: { keepRecentTokens: 50_000 } });
		const { policy, warnings } = loadConfig(agentDir, cwd, { projectTrusted: true });
		expect(policy.autoResume).toBe(false);
		expect(warnings.some((w) => w.includes("autoResume disabled"))).toBe(true);
	});

	it("warns on invalid JSON without throwing", () => {
		const { agentDir, cwd } = makeDirs();
		writeFileSync(join(agentDir, "settings.json"), "{ not json");
		const { policy, warnings } = loadConfig(agentDir, cwd, { projectTrusted: true });
		expect(policy).toEqual(DEFAULT_POLICY);
		expect(warnings.some((w) => w.includes("invalid JSON"))).toBe(true);
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
