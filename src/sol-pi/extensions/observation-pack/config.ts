/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

export type ObservationPackThresholdsKiB = Readonly<Record<string, number>>;
export type EffectiveObservationPackThresholdsKiB = ObservationPackThresholdsKiB & { readonly default: number };

export const DEFAULT_OBSERVATION_PACK_THRESHOLDS_KIB: EffectiveObservationPackThresholdsKiB = Object.freeze({
	default: 10,
});
const MAX_THRESHOLD_KIB = Math.floor(Number.MAX_SAFE_INTEGER / 1024);

/** Snapshot the map so provider projections cannot change it during a session. */
export function normalizeObservationPackThresholdsKiB(value: unknown = {}): EffectiveObservationPackThresholdsKiB {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("observationPackThresholdsKiB must be a JSON object");
	}
	for (const [tool, threshold] of Object.entries(value)) {
		if (tool.length === 0 || /\s/u.test(tool)) {
			throw new Error("observationPackThresholdsKiB keys must be non-empty tool names without whitespace");
		}
		if (
			typeof threshold !== "number" ||
			!Number.isSafeInteger(threshold) ||
			threshold <= 0 ||
			threshold > MAX_THRESHOLD_KIB
		) {
			throw new Error(`observationPackThresholdsKiB.${tool} must be a positive integer KiB value no greater than ${MAX_THRESHOLD_KIB}`);
		}
	}
	// Object spread preserves literal keys such as __proto__ as own properties.
	return Object.freeze({ ...DEFAULT_OBSERVATION_PACK_THRESHOLDS_KIB, ...value }) as EffectiveObservationPackThresholdsKiB;
}

export function observationThresholdBytes(thresholds: EffectiveObservationPackThresholdsKiB, toolName: string): number {
	return (Object.hasOwn(thresholds, toolName) ? thresholds[toolName]! : thresholds.default) * 1024;
}
