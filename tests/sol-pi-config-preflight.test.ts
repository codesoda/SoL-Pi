/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { loadSolPiConfig } from "../src/sol-pi/config.ts";

const SCRIPT = join(process.cwd(), "scripts/check-sol-pi-config.mjs");

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "sol-pi-config-preflight-"));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function writeConfig(value: unknown): string {
	const path = join(directory, "sol-pi.json");
	writeFileSync(path, JSON.stringify(value));
	return path;
}

function run(config: string, requireAllEnabled = true) {
	const args = [SCRIPT, "--config", config];
	if (requireAllEnabled) args.push("--require-all-enabled");
	return spawnSync(process.execPath, args, {
		cwd: process.cwd(),
		encoding: "utf8",
	});
}

function writeLayers(globalText: string, projectText: string) {
	const agentDir = join(directory, "agent");
	const projectDir = join(directory, CONFIG_DIR_NAME);
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	const globalPath = join(agentDir, "sol-pi.json");
	const projectPath = join(projectDir, "sol-pi.json");
	writeFileSync(globalPath, globalText);
	writeFileSync(projectPath, projectText);
	return { agentDir, globalPath, projectPath };
}

const DEFAULT_EPR_PROVIDER = ["openai", "codex"].join("-");
const DEFAULT_EPR_MODEL = ["gpt-5.6", "luna"].join("-");

const ALL_ENABLED = {
	version: 1,
	actionFusion: true,
	observationPack: true,
	evidencePreservingReducer: true,
	evidencePreservingReducerProvider: DEFAULT_EPR_PROVIDER,
	evidencePreservingReducerModel: DEFAULT_EPR_MODEL,
	onlineContextCompact: true,
	cacheWriteReadRatio: 12.5,
};

describe("SoL-Pi configuration preflight", () => {
	it("accepts the exact all-enabled configuration", () => {
		const result = run(writeConfig(ALL_ENABLED));
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: true,
			all_enabled: true,
			effective_config: {
				observationPackThresholdsKiB: { default: 10 },
				cacheWriteReadRatio: 12.5,
				evidencePreservingReducerProvider: DEFAULT_EPR_PROVIDER,
				evidencePreservingReducerModel: DEFAULT_EPR_MODEL,
			},
		});
	});

	it("applies the default ratio when the field is omitted", () => {
		const { cacheWriteReadRatio: _ratio, ...withoutRatio } = ALL_ENABLED;
		const result = run(writeConfig(withoutRatio));
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout).effective_config.cacheWriteReadRatio).toBe(12.5);
	});

	it("applies default EPR reducer provider/model when those fields are omitted", () => {
		const {
			evidencePreservingReducerModel: _model,
			evidencePreservingReducerProvider: _provider,
			...withoutReducerRoute
		} = ALL_ENABLED;
		const result = run(writeConfig(withoutReducerRoute));
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout).effective_config).toMatchObject({
			evidencePreservingReducerProvider: DEFAULT_EPR_PROVIDER,
			evidencePreservingReducerModel: DEFAULT_EPR_MODEL,
		});
	});

	it("normalizes surrounding whitespace in the reported EPR reducer route", () => {
		const result = run(
			writeConfig({
				...ALL_ENABLED,
				evidencePreservingReducerProvider: `  ${DEFAULT_EPR_PROVIDER}\t`,
				evidencePreservingReducerModel: `\n${DEFAULT_EPR_MODEL}  `,
			}),
		);

		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout).effective_config).toMatchObject({
			evidencePreservingReducerProvider: DEFAULT_EPR_PROVIDER,
			evidencePreservingReducerModel: DEFAULT_EPR_MODEL,
		});
	});

	it.each([null, "12.5", -1])("rejects an invalid ratio: %j", (cacheWriteReadRatio) => {
		const result = run(writeConfig({ ...ALL_ENABLED, cacheWriteReadRatio }));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("cacheWriteReadRatio must be a finite non-negative number");
	});

	it.each([
		["evidencePreservingReducerProvider", ""],
		["evidencePreservingReducerProvider", null],
		["evidencePreservingReducerModel", ""],
		["evidencePreservingReducerModel", null],
	] as const)("rejects an invalid reducer route: %s=%j", (key, value) => {
		const result = run(writeConfig({ ...ALL_ENABLED, [key]: value }));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`${key} must be a non-empty string`);
	});

	it("rejects a disabled or missing mechanism", () => {
		for (const config of [
			{ ...ALL_ENABLED, onlineContextCompact: false },
			{ version: 1, actionFusion: true, observationPack: true, evidencePreservingReducer: true },
		]) {
			const result = run(writeConfig(config));
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("onlineContextCompact must be true");
		}
	});

	it("accepts a valid partially enabled config when all-enabled mode is not requested", () => {
		const result = run(writeConfig({ version: 1, actionFusion: true }), false);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ all_enabled: false });
	});

	describe("Observation Pack runtime/preflight parity", () => {
		it.each([
			["omitted map", undefined, { default: 10 }],
			["empty map", {}, { default: 10 }],
			["omitted default when it is 10", { bash: 4 }, { default: 10, bash: 4 }],
			["explicit default", { default: 8, bash: 4 }, { default: 8, bash: 4 }],
			["minimum", { default: 1, bash: 1 }, { default: 1, bash: 1 }],
			[
				"maximum safe KiB value",
				{ bash: Math.floor(Number.MAX_SAFE_INTEGER / 1024) },
				{ default: 10, bash: Math.floor(Number.MAX_SAFE_INTEGER / 1024) },
			],
			["case-sensitive names", { bash: 4, Bash: 6, DEFAULT: 7 }, { default: 10, bash: 4, Bash: 6, DEFAULT: 7 }],
			[
				"special own names",
				JSON.parse('{"__proto__":3,"constructor":4,"toString":5}'),
				JSON.parse('{"default":10,"__proto__":3,"constructor":4,"toString":5}'),
			],
		] as const)("reports the same effective config for %s", (_label, observationPackThresholdsKiB, expected) => {
			const path = writeConfig({ ...ALL_ENABLED, observationPackThresholdsKiB });
			const runtimeConfig = loadSolPiConfig(directory, directory, false);
			const result = run(path);

			expect(result.status).toBe(0);
			const report = JSON.parse(result.stdout);
			expect(report.all_enabled).toBe(true);
			expect(report.effective_config).toEqual(runtimeConfig);
			expect(report.effective_config.observationPackThresholdsKiB).toEqual(expected);
			expect(Object.keys(report.effective_config.observationPackThresholdsKiB).sort()).toEqual(Object.keys(expected).sort());
			for (const key of Object.keys(expected)) {
				expect(Object.hasOwn(runtimeConfig.observationPackThresholdsKiB, key)).toBe(true);
				expect(Object.hasOwn(report.effective_config.observationPackThresholdsKiB, key)).toBe(true);
			}
		});

		it.each([
			["null map", "null"],
			["array map", "[]"],
			["string map", '"4"'],
			["number map", "4"],
			["boolean map", "true"],
			["zero", '{"bash":0}'],
			["negative", '{"bash":-1}'],
			["fraction", '{"bash":1.5}'],
			["string value", '{"bash":"4"}'],
			["null value", '{"bash":null}'],
			["boolean value", '{"bash":false}'],
			["array value", '{"bash":[]}'],
			["object value", '{"bash":{}}'],
			["nonfinite value", '{"bash":1e309}'],
			["negative nonfinite value", '{"bash":-1e309}'],
			["unsafe byte conversion", `{"bash":${Math.floor(Number.MAX_SAFE_INTEGER / 1024) + 1}}`],
			["invalid reserved default", '{"default":0}'],
			["nonfinite default", '{"default":1e309}'],
			["empty tool name", '{"":4}'],
			["leading whitespace", '{" bash":4}'],
			["trailing whitespace", '{"bash ":4}'],
			["internal whitespace", '{"my tool":4}'],
			["tab", JSON.stringify({ "my\ttool": 4 })],
			["newline", JSON.stringify({ "my\ntool": 4 })],
			["nonbreaking space", JSON.stringify({ "my\u00a0tool": 4 })],
			["invalid special own value", '{"__proto__":{}}'],
		] as const)("rejects the same invalid input: %s", (_label, mapJson) => {
			const path = join(directory, "sol-pi.json");
			// Keep overflow literals intact instead of stringifying Infinity to null.
			writeFileSync(path, `{"version":1,"observationPackThresholdsKiB":${mapJson}}`);
			expect(() => loadSolPiConfig(directory, directory, false)).toThrow(/observationPackThresholdsKiB/);
			const result = run(path, false);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("observationPackThresholdsKiB");
		});
	});

	describe("selected project runtime/preflight parity", () => {
		it.each([
			["omitted project map", undefined, { default: 10 }],
			["empty project map", {}, { default: 10 }],
			["project without default", { bash: 4 }, { default: 10, bash: 4 }],
			["project default only", { default: 6 }, { default: 6 }],
			["project default and tool override", { default: 6, bash: 4 }, { default: 6, bash: 4 }],
		] as const)("replaces the entire global config: %s", (_label, observationPackThresholdsKiB, expected) => {
			const { agentDir, projectPath } = writeLayers(
				JSON.stringify({ ...ALL_ENABLED, observationPackThresholdsKiB: { default: 8, bash: 12, read: 20 } }),
				JSON.stringify({ version: 1, observationPackThresholdsKiB }),
			);
			const runtimeConfig = loadSolPiConfig(directory, agentDir, true);
			const result = run(projectPath, false);
			expect(result.status).toBe(0);
			const report = JSON.parse(result.stdout);
			expect(report.all_enabled).toBe(false);
			expect(report.effective_config).toEqual(runtimeConfig);
			expect(report.effective_config.observationPackThresholdsKiB).toEqual(expected);
			expect(report.effective_config.observationPack).toBe(false);
		});
	});

	it("rejects unknown configuration keys", () => {
		const result = run(writeConfig({ ...ALL_ENABLED, provider: "custom" }));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("unknown key: provider");
	});
});
