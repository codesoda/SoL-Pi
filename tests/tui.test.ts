/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	formatSavingsBytes,
	formatSavingsCount,
	renderSolPiTool,
	showSolPiSavings,
} from "../src/sol-pi/tui.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function uiContext(mode: ExtensionContext["mode"]) {
	const notify = vi.fn();
	const setStatus = vi.fn();
	return {
		context: { mode, ui: { notify, setStatus } } as unknown as ExtensionContext,
		notify,
		setStatus,
	};
}

describe("SoL-Pi TUI savings presentation", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders an English lightning header and measurable savings above the original tool component", () => {
		const component = renderSolPiTool(
			theme,
			"Action Fusion",
			"1 model round-trip avoided",
			new Text("original edit renderer", 0, 0),
		);

		expect(component.render(100).map((line) => line.trimEnd()).join("\n")).toBe(
			"⚡ SoL-Pi · Action Fusion\nMoney saved · 1 model round-trip avoided\noriginal edit renderer",
		);
	});

	it("formats token and byte savings without inventing a currency amount", () => {
		expect(formatSavingsCount(12_345, "context tokens avoided")).toBe("12,345 context tokens avoided");
		expect(formatSavingsBytes(78_200)).toBe("76.4 KiB removed from future prompts");
	});

	it("shows a TUI notification and clears its footer status", () => {
		vi.useFakeTimers();
		const { context, notify, setStatus } = uiContext("tui");

		showSolPiSavings(context, "Online Context Compact", "84,026 context tokens removed");

		expect(notify).toHaveBeenCalledWith(
			"⚡ SoL-Pi · Online Context Compact\nMoney saved · 84,026 context tokens removed",
			"info",
		);
		expect(setStatus).toHaveBeenCalledWith(
			"sol-pi-savings",
			"⚡ Online Context Compact · 84,026 context tokens removed",
		);
		vi.advanceTimersByTime(4_000);
		expect(setStatus).toHaveBeenLastCalledWith("sol-pi-savings", undefined);
	});

	it.each(["Action Fusion", "Observation Pack", "Luna Delegating", "Online Context Compact"] as const)(
		"emits an RPC info notification without footer updates or timers for %s",
		(mechanism) => {
			vi.useFakeTimers();
			const { context, notify, setStatus } = uiContext("rpc");
			showSolPiSavings(context, mechanism, "probe saving");
			expect(notify).toHaveBeenCalledExactlyOnceWith(`⚡ SoL-Pi · ${mechanism}\nMoney saved · probe saving`, "info");
			expect(setStatus).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each(["json", "print"] as const)("does not emit presentation in %s mode", (mode) => {
		const { context, notify, setStatus } = uiContext(mode);

		showSolPiSavings(context, "Action Fusion", "1 model round-trip avoided");

		expect(notify).not.toHaveBeenCalled();
		expect(setStatus).not.toHaveBeenCalled();
	});
});
