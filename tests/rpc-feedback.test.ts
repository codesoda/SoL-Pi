/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/sol-pi/config.ts";

interface CapturedMessage {
	role: string;
	toolCallId?: string;
	toolName?: string;
	content: string | Array<{ type: string; text?: string }>;
	isError?: boolean;
	stopReason?: string;
}

type RpcRecord = Record<string, unknown>;

function toolResult(messages: CapturedMessage[], id: string): CapturedMessage {
	const message = messages.find((entry) => entry.role === "toolResult" && entry.toolCallId === id);
	expect(message, `missing tool result ${id}`).toBeDefined();
	return message!;
}

it("sends RPC savings notifications once per action, without changing transcript or provider content", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sol-pi-rpc-feedback-"));
	try {
		const agentDir = join(cwd, "agent");
		const temporaryDir = join(cwd, "tmp");
		await Promise.all([agentDir, temporaryDir, join(cwd, CONFIG_DIR_NAME)].map((path) => mkdir(path)));
		await writeFile(join(cwd, CONFIG_DIR_NAME, "sol-pi.json"), JSON.stringify({
			...DEFAULT_CONFIG,
			actionFusion: true,
			observationPack: true,
			observationPackThresholdsKiB: { bash: 4 },
			evidencePreservingReducer: false,
			onlineContextCompact: false,
		}));
		// Exactly 5 KiB: above the configured bash threshold, below Pi's truncation limit.
		const logBody = `${"rpc fixture evidence ".padEnd(63, ".")}\n`.repeat(80);
		expect(Buffer.byteLength(logBody)).toBe(5 * 1024);
		const writtenBody = "RPC fused write succeeded\n";
		const smallBody = "small follow-up evidence\n";
		await writeFile(join(cwd, "fixture.log"), logBody);
		await writeFile(join(cwd, "small.txt"), smallBody);
		const payloadPath = join(cwd, "provider-payloads.jsonl");
		const providerPath = join(cwd, "test-provider.ts");
		const fauxPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/providers/faux"));
		await writeFile(providerPath, `
import { appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(fauxPath)};
export default function (pi) {
	const faux = fauxProvider({
		provider: "sol-pi-rpc-feedback-test", api: "sol-pi-rpc-feedback-test-api",
		models: [{ id: "deterministic", contextWindow: 200000, maxTokens: 4096 }],
		tokenSize: { min: 10000, max: 10000 },
	});
	const call = (id, name, args) => fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
	const responses = [
		call("fused-write", "write", { path: "result.txt", content: ${JSON.stringify(writtenBody)}, then_run: { command: "cat result.txt" } }),
		call("large-bash", "bash", { command: "cat fixture.log" }),
		call("small-1", "read", { path: "small.txt" }),
		call("small-2", "read", { path: "small.txt" }),
		call("small-3", "read", { path: "small.txt" }),
		fauxAssistantMessage("RPC feedback complete"),
	];
	// Pi's faux provider does not call onPayload itself. Exercise the real Pi
	// before_provider_request bridge at this deterministic provider boundary.
	faux.setResponses(responses.map((response) => async (context, options, _state, model) => {
		await options.onPayload(context, model);
		return response;
	}));
	pi.registerProvider(faux.provider);
	pi.on("before_provider_request", (event) => {
		appendFileSync(${JSON.stringify(payloadPath)}, JSON.stringify(event.payload) + "\\n");
	});
}
`);
		const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
		const records: RpcRecord[] = [];
		const protocolErrors: string[] = [];
		let stderr = "";
		let pending = "";
		let settled = false;
		let messagesRequestedAfterSettled = false;
		const child = spawn(process.execPath, [
			join(piDist, "bundle/cli.js"), "--mode", "rpc", "--offline", "--approve", "--no-session",
			"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
			"-e", fileURLToPath(new URL("../src/sol-pi/index.ts", import.meta.url)), "-e", providerPath,
			"--provider", "sol-pi-rpc-feedback-test", "--model", "deterministic", "--thinking", "off",
		], {
			cwd,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TMPDIR: temporaryDir, TMP: temporaryDir, TEMP: temporaryDir },
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 20_000,
			killSignal: "SIGKILL",
		});
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => resolve({ code, signal }));
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		child.stdin.on("error", (error) => { protocolErrors.push(error.message); });
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			pending += chunk;
			let newline: number;
			while ((newline = pending.indexOf("\n")) !== -1) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				try {
					const record = JSON.parse(line) as RpcRecord;
					records.push(record);
					if (record.type === "agent_settled" && !settled) {
						settled = true;
						messagesRequestedAfterSettled = true;
						child.stdin.write(`${JSON.stringify({ id: "messages", type: "get_messages" })}\n`);
					}
					if (record.type === "response" && record.id === "messages") {
						// EOF shuts Pi down: never send it while the agent is still running.
						child.stdin.end();
					}
				} catch (error) {
					protocolErrors.push(String(error));
					child.kill("SIGKILL");
				}
			}
		});
		child.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: "Run the deterministic RPC feedback scenario." })}\n`);
		const outcome = await exited;
		expect(outcome, stderr).toEqual({ code: 0, signal: null });
		expect(protocolErrors).toEqual([]);
		expect(pending).toBe("");
		expect(stderr).not.toMatch(/error|failed|fail-open/iu);
		expect(records.filter((record) => record.type === "extension_error")).toEqual([]);
		expect(records.filter((record) => record.type === "response" && record.success === false)).toEqual([]);
		expect(records.find((record) => record.id === "prompt")).toMatchObject({
			type: "response", command: "prompt", success: true, data: { disposition: "started" },
		});
		expect(messagesRequestedAfterSettled).toBe(true);
		expect(records.filter((record) => record.type === "agent_settled")).toHaveLength(1);

		const ui = records.filter((record) => record.type === "extension_ui_request");
		expect(ui.filter((record) => record.method === "setStatus" || record.method === "setWidget")).toEqual([]);
		expect(ui).toHaveLength(2);
		expect(ui[0]).toMatchObject({ method: "notify", notifyType: "info", message: expect.stringContaining("Action Fusion") });
		expect(ui[1]).toMatchObject({ method: "notify", notifyType: "info", message: expect.stringContaining("Observation Pack") });
		for (const notification of ui) expect(notification.message).toContain("Money saved ·");

		const messagesResponse = records.find((record) => record.id === "messages");
		expect(messagesResponse).toMatchObject({ type: "response", command: "get_messages", success: true });
		const transcript = (messagesResponse!.data as { messages: CapturedMessage[] }).messages;
		const bashResult = toolResult(transcript, "large-bash");
		expect(bashResult).toMatchObject({ toolName: "bash", isError: false, content: [{ type: "text", text: logBody }] });
		const writeResult = toolResult(transcript, "fused-write");
		expect(writeResult.isError).toBe(false);
		expect(JSON.stringify(writeResult.content)).toContain("[then_run:succeeded]");
		expect(JSON.stringify(writeResult.content)).toContain(writtenBody.trim());
		expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe(writtenBody);
		expect(transcript.filter((message) => message.role === "assistant")).toHaveLength(6);
		expect(transcript.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "RPC feedback complete" }] });
		for (const id of ["small-1", "small-2", "small-3"]) {
			expect(toolResult(transcript, id)).toMatchObject({ isError: false, content: [{ type: "text", text: smallBody }] });
		}

		const payloadStrings = (await readFile(payloadPath, "utf8")).trim().split("\n");
		expect(payloadStrings).toHaveLength(6);
		const payloads = payloadStrings.map((line) => JSON.parse(line) as { messages: CapturedMessage[] });
		// Requests 3/4 contain the complete bash output; requests 5/6 reuse one placeholder.
		for (const index of [2, 3]) expect(toolResult(payloads[index]!.messages, "large-bash").content).toEqual(bashResult.content);
		const packed = toolResult(payloads[4]!.messages, "large-bash").content;
		expect(JSON.stringify(packed)).toContain("[large tool result replaced");
		expect(JSON.stringify(packed)).toContain("obs_recall");
		expect(JSON.stringify(packed).length).toBeLessThan(JSON.stringify(bashResult.content).length);
		expect(toolResult(payloads[5]!.messages, "large-bash").content).toEqual(packed);
		// Small results, including the fused mutation/command result, stay byte-for-byte unchanged.
		for (const payload of payloads.slice(1)) {
			expect(toolResult(payload.messages, "fused-write").content).toEqual(writeResult.content);
		}
		for (const id of ["small-1", "small-2", "small-3"]) {
			expect(toolResult(payloads[5]!.messages, id).content).toEqual(toolResult(transcript, id).content);
		}
		for (const serialized of [JSON.stringify(transcript), ...payloadStrings]) {
			expect(serialized).not.toContain("Money saved ·");
			for (const notification of ui) expect(serialized).not.toContain(JSON.stringify(notification.message).slice(1, -1));
		}

		const roots = (await readdir(temporaryDir)).filter((name) => name.startsWith("sol-pi-"));
		expect(roots).toHaveLength(1);
		const observationDir = join(temporaryDir, roots[0]!, "observation-pack");
		const ledger = (await readFile(join(observationDir, "ledger.jsonl"), "utf8")).trim().split("\n")
			.map((line) => JSON.parse(line) as { event: string; request: number; originalBytes: number });
		expect(ledger.map(({ event, request }) => ({ event, request }))).toEqual([
			{ event: "full", request: 3 }, { event: "full", request: 4 },
			{ event: "placeholder", request: 5 }, { event: "placeholder", request: 6 },
		]);
		expect(ledger.every((entry) => entry.originalBytes === Buffer.byteLength(logBody))).toBe(true);
		const objects = await readdir(join(observationDir, "objects"));
		expect(objects).toHaveLength(1);
		expect(await readFile(join(observationDir, "objects", objects[0]!), "utf8")).toBe(logBody);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}, 30_000);
