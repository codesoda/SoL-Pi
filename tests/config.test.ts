/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, findConfigPath, loadSolPiConfig } from "../src/sol-pi/config.ts";
import {
	DEFAULT_REDUCER_MODEL,
	DEFAULT_REDUCER_PROVIDER,
} from "../src/sol-pi/extensions/evidence-preserving-reducer/config.ts";

const roots: string[] = [];

function fixture(): { agentDir: string; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), "sol-pi-config-"));
	roots.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	return { agentDir, cwd };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SoL-Pi config", () => {
	it("returns disabled defaults when neither config exists", () => {
		const { agentDir, cwd } = fixture();
		expect(findConfigPath(cwd, agentDir, true)).toBeUndefined();
		expect(loadSolPiConfig(cwd, agentDir, true)).toEqual(DEFAULT_CONFIG);
		expect(DEFAULT_CONFIG.observationPackThresholdsKiB).toEqual({ default: 10 });
		expect(Object.isFrozen(DEFAULT_CONFIG.observationPackThresholdsKiB)).toBe(true);
		expect(DEFAULT_CONFIG.cacheWriteReadRatio).toBe(12.5);
		expect(DEFAULT_CONFIG.evidencePreservingReducerProvider).toBe(DEFAULT_REDUCER_PROVIDER);
		expect(DEFAULT_CONFIG.evidencePreservingReducerModel).toBe(DEFAULT_REDUCER_MODEL);
	});

	it("loads the global config as a fallback", () => {
		const { agentDir, cwd } = fixture();
		const path = join(agentDir, "sol-pi.json");
		writeFileSync(path, JSON.stringify({ version: 1, observationPack: true, onlineContextCompact: true }));
		expect(findConfigPath(cwd, agentDir, true)).toBe(path);
		expect(loadSolPiConfig(cwd, agentDir, true)).toEqual({
			...DEFAULT_CONFIG,
			observationPack: true,
			onlineContextCompact: true,
		});
	});

	it("uses the project config instead of merging the global config", () => {
		const { agentDir, cwd } = fixture();
		writeFileSync(
			join(agentDir, "sol-pi.json"),
			JSON.stringify({ version: 1, observationPack: true }),
		);
		mkdirSync(join(cwd, CONFIG_DIR_NAME));
		const projectPath = join(cwd, CONFIG_DIR_NAME, "sol-pi.json");
		writeFileSync(projectPath, JSON.stringify({ version: 1, actionFusion: true }));

		expect(findConfigPath(cwd, agentDir, true)).toBe(projectPath);
		expect(loadSolPiConfig(cwd, agentDir, true)).toEqual({ ...DEFAULT_CONFIG, actionFusion: true });
	});

	it("ignores the project config when Pi has not trusted the project", () => {
		const { agentDir, cwd } = fixture();
		writeFileSync(
			join(agentDir, "sol-pi.json"),
			JSON.stringify({ version: 1, observationPack: true }),
		);
		mkdirSync(join(cwd, CONFIG_DIR_NAME));
		writeFileSync(join(cwd, CONFIG_DIR_NAME, "sol-pi.json"), JSON.stringify({ version: 1, actionFusion: true }));

		expect(loadSolPiConfig(cwd, agentDir, false)).toEqual({ ...DEFAULT_CONFIG, observationPack: true });
	});

	it("rejects unknown keys", () => {
		const { agentDir, cwd } = fixture();
		mkdirSync(join(cwd, CONFIG_DIR_NAME));
		writeFileSync(join(cwd, CONFIG_DIR_NAME, "sol-pi.json"), JSON.stringify({ version: 1, actionFussion: true }));
		expect(() => loadSolPiConfig(cwd, agentDir, true)).toThrow("Unknown SoL-Pi config key: actionFussion");
	});

	it("rejects non-boolean feature values", () => {
		const { agentDir, cwd } = fixture();
		mkdirSync(join(cwd, CONFIG_DIR_NAME));
		writeFileSync(join(cwd, CONFIG_DIR_NAME, "sol-pi.json"), JSON.stringify({ version: 1, actionFusion: "yes" }));
		expect(() => loadSolPiConfig(cwd, agentDir, true)).toThrow("SoL-Pi config actionFusion must be boolean");
	});

	it("rejects a non-boolean Online Context Compact value", () => {
		const { agentDir, cwd } = fixture();
		mkdirSync(join(cwd, CONFIG_DIR_NAME));
		writeFileSync(
			join(cwd, CONFIG_DIR_NAME, "sol-pi.json"),
			JSON.stringify({ version: 1, onlineContextCompact: "yes" }),
		);
		expect(() => loadSolPiConfig(cwd, agentDir, true)).toThrow(
			"SoL-Pi config onlineContextCompact must be boolean",
		);
	});

	it("loads an explicit cache write/read ratio, including zero", () => {
		for (const cacheWriteReadRatio of [0, 3.25]) {
			const { agentDir, cwd } = fixture();
			const path = join(agentDir, "sol-pi.json");
			writeFileSync(path, JSON.stringify({ version: 1, cacheWriteReadRatio }));
			expect(loadSolPiConfig(cwd, agentDir, true).cacheWriteReadRatio).toBe(cacheWriteReadRatio);
		}
	});

	it("loads an explicit Evidence-Preserving Reducer provider/model route", () => {
		const { agentDir, cwd } = fixture();
		const path = join(agentDir, "sol-pi.json");
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				evidencePreservingReducerProvider: "test-provider",
				evidencePreservingReducerModel: "test-reducer-model",
			}),
		);
		expect(loadSolPiConfig(cwd, agentDir, true)).toEqual({
			...DEFAULT_CONFIG,
			evidencePreservingReducerProvider: "test-provider",
			evidencePreservingReducerModel: "test-reducer-model",
		});
	});

	it("normalizes surrounding whitespace in the EPR reducer route", () => {
		const { agentDir, cwd } = fixture();
		const path = join(agentDir, "sol-pi.json");
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				evidencePreservingReducerProvider: "  test-provider\t",
				evidencePreservingReducerModel: "\n test-reducer-model  ",
			}),
		);

		expect(loadSolPiConfig(cwd, agentDir, true)).toMatchObject({
			evidencePreservingReducerProvider: "test-provider",
			evidencePreservingReducerModel: "test-reducer-model",
		});
	});

	it.each([
		["evidencePreservingReducerProvider", ""],
		["evidencePreservingReducerProvider", 12],
		["evidencePreservingReducerModel", ""],
		["evidencePreservingReducerModel", 12],
	] as const)("rejects an invalid EPR reducer string: %s=%j", (key, value) => {
		const { agentDir, cwd } = fixture();
		const path = join(agentDir, "sol-pi.json");
		writeFileSync(path, JSON.stringify({ version: 1, [key]: value }));
		expect(() => loadSolPiConfig(cwd, agentDir, true)).toThrow(
			`SoL-Pi config ${key} must be a non-empty string`,
		);
	});

	it.each([null, "12.5", -1])("rejects an invalid cache write/read ratio: %j", (cacheWriteReadRatio) => {
		const { agentDir, cwd } = fixture();
		const path = join(agentDir, "sol-pi.json");
		writeFileSync(path, JSON.stringify({ version: 1, cacheWriteReadRatio }));
		expect(() => loadSolPiConfig(cwd, agentDir, true)).toThrow(
			"SoL-Pi config cacheWriteReadRatio must be a finite non-negative number",
		);
	});

	describe("Observation Pack thresholds", () => {
		it.each([
			["omitted map", undefined, { default: 10 }],
			["empty map", {}, { default: 10 }],
			["omitted default when it is 10", { bash: 4 }, { default: 10, bash: 4 }],
			["explicit default", { default: 8, bash: 4 }, { default: 8, bash: 4 }],
			["minimum", { default: 1, bash: 1 }, { default: 1, bash: 1 }],
			[
				"maximum safe KiB value",
				{ default: Math.floor(Number.MAX_SAFE_INTEGER / 1024), bash: Math.floor(Number.MAX_SAFE_INTEGER / 1024) },
				{ default: Math.floor(Number.MAX_SAFE_INTEGER / 1024), bash: Math.floor(Number.MAX_SAFE_INTEGER / 1024) },
			],
			[
				"exact case-sensitive tool names",
				{ bash: 4, Bash: 6, DEFAULT: 7, "mcp.server/tool-name": 9 },
				{ default: 10, bash: 4, Bash: 6, DEFAULT: 7, "mcp.server/tool-name": 9 },
			],
		] as const)("normalizes and freezes %s", (_label, observationPackThresholdsKiB, expected) => {
			const { agentDir, cwd } = fixture();
			writeFileSync(join(agentDir, "sol-pi.json"), JSON.stringify({ version: 1, observationPackThresholdsKiB }));

			const config = loadSolPiConfig(cwd, agentDir, true);
			expect(config.observationPackThresholdsKiB).toEqual(expected);
			expect(Object.isFrozen(config.observationPackThresholdsKiB)).toBe(true);
			expect(Reflect.set(config.observationPackThresholdsKiB, "default", 99)).toBe(false);
			expect(config.observationPackThresholdsKiB).toEqual(expected);
			expect(DEFAULT_CONFIG.observationPackThresholdsKiB).toEqual({ default: 10 });
		});

		it.each([null, [], "4", 4, true, false])("rejects a non-object map: %j", (observationPackThresholdsKiB) => {
			const { agentDir, cwd } = fixture();
			writeFileSync(join(agentDir, "sol-pi.json"), JSON.stringify({ version: 1, observationPackThresholdsKiB }));
			expect(() => loadSolPiConfig(cwd, agentDir, true)).toThrow(/observationPackThresholdsKiB/);
		});

		it.each([0, -1, 1.5, "4", null, true, false, [], {}, Math.floor(Number.MAX_SAFE_INTEGER / 1024) + 1])(
			"rejects invalid default and tool values: %j",
			(value) => {
				for (const key of ["default", "bash"]) {
					const { agentDir, cwd } = fixture();
					writeFileSync(
						join(agentDir, "sol-pi.json"),
						JSON.stringify({ version: 1, observationPackThresholdsKiB: { [key]: value } }),
					);
					expect(() => loadSolPiConfig(cwd, agentDir, true)).toThrow(/observationPackThresholdsKiB/);
				}
			},
		);

		it.each(["1e309", "-1e309"])("rejects a nonfinite JSON number: %s", (value) => {
			for (const key of ["default", "bash"]) {
				const { agentDir, cwd } = fixture();
				// JSON.stringify would turn Infinity into null, hiding the nonfinite-number check.
				writeFileSync(join(agentDir, "sol-pi.json"), `{"version":1,"observationPackThresholdsKiB":{"${key}":${value}}}`);
				expect(() => loadSolPiConfig(cwd, agentDir, true)).toThrow(/observationPackThresholdsKiB/);
			}
		});

		it.each(["", " ", " bash", "bash ", "my tool", "my\ttool", "my\ntool", "my\rtool", "my\u00a0tool"])(
			"rejects an empty or whitespace-containing tool name: %j",
			(key) => {
				const { agentDir, cwd } = fixture();
				writeFileSync(
					join(agentDir, "sol-pi.json"),
					JSON.stringify({ version: 1, observationPackThresholdsKiB: { [key]: 4 } }),
				);
				expect(() => loadSolPiConfig(cwd, agentDir, true)).toThrow(/observationPackThresholdsKiB/);
			},
		);

		it("preserves special own tool names without prototype pollution", () => {
			const { agentDir, cwd } = fixture();
			const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
			writeFileSync(
				join(agentDir, "sol-pi.json"),
				'{"version":1,"observationPackThresholdsKiB":{"__proto__":3,"constructor":4,"toString":5}}',
			);

			const thresholds = loadSolPiConfig(cwd, agentDir, true).observationPackThresholdsKiB;
			expect(Object.keys(thresholds).sort()).toEqual(["__proto__", "constructor", "default", "toString"]);
			for (const [key, value] of [["__proto__", 3], ["constructor", 4], ["toString", 5]] as const) {
				expect(Object.hasOwn(thresholds, key)).toBe(true);
				expect(thresholds[key]).toBe(value);
			}
			expect(thresholds.default).toBe(10);
			expect(Object.isFrozen(thresholds)).toBe(true);
			expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototypeBefore);
			expect(Object.getPrototypeOf({})).toBe(Object.prototype);
			expect(DEFAULT_CONFIG.observationPackThresholdsKiB).toEqual({ default: 10 });
		});

		it.each([
			["omitted project map", undefined, { default: 10 }],
			["empty project map", {}, { default: 10 }],
			["project map without default", { bash: 4 }, { default: 10, bash: 4 }],
			["project default only", { default: 6 }, { default: 6 }],
			["project map with default", { default: 6, bash: 4 }, { default: 6, bash: 4 }],
		] as const)("replaces the entire global map with %s", (_label, observationPackThresholdsKiB, expected) => {
			const { agentDir, cwd } = fixture();
			writeFileSync(
				join(agentDir, "sol-pi.json"),
				JSON.stringify({ version: 1, observationPackThresholdsKiB: { default: 8, bash: 16, read: 30 } }),
			);
			mkdirSync(join(cwd, CONFIG_DIR_NAME));
			writeFileSync(join(cwd, CONFIG_DIR_NAME, "sol-pi.json"), JSON.stringify({ version: 1, observationPackThresholdsKiB }));

			expect(loadSolPiConfig(cwd, agentDir, true).observationPackThresholdsKiB).toEqual(expected);
		});

		it.each([{ bash: 4 }, null])("ignores untrusted project thresholds: %j", (observationPackThresholdsKiB) => {
			const { agentDir, cwd } = fixture();
			mkdirSync(join(cwd, CONFIG_DIR_NAME));
			writeFileSync(join(cwd, CONFIG_DIR_NAME, "sol-pi.json"), JSON.stringify({ version: 1, observationPackThresholdsKiB }));
			expect(loadSolPiConfig(cwd, agentDir, false).observationPackThresholdsKiB).toEqual({ default: 10 });

			writeFileSync(
				join(agentDir, "sol-pi.json"),
				JSON.stringify({ version: 1, observationPackThresholdsKiB: { default: 20, read: 30 } }),
			);
			expect(loadSolPiConfig(cwd, agentDir, false).observationPackThresholdsKiB).toEqual({ default: 20, read: 30 });
		});
	});

	it("wraps malformed JSON errors with the config path", () => {
		const { agentDir, cwd } = fixture();
		mkdirSync(join(cwd, CONFIG_DIR_NAME));
		const path = join(cwd, CONFIG_DIR_NAME, "sol-pi.json");
		writeFileSync(path, "{");
		expect(() => loadSolPiConfig(cwd, agentDir, true)).toThrow(`Unable to read SoL-Pi config ${path}`);
	});
});
