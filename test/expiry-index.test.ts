import assert from "node:assert/strict";
import test from "node:test";
import extension from "../src/expiry.ts";
import { REMINDER_TYPE } from "../src/expiry-core.ts";

type Handler = (event: any, ctx: any) => unknown;

function harness(entries: any[], model: any, tools = ["read", "bash"]) {
	const handlers = new Map<string, Handler[]>();
	const appended: { type: string; data: any }[] = [];
	const pi: any = {
		on: (name: string, h: Handler) => {
			handlers.set(name, [...(handlers.get(name) ?? []), h]);
			return () => {};
		},
		registerEntryRenderer: () => {},
		getActiveTools: () => tools,
		appendEntry: (type: string, data: any) => {
			appended.push({ type, data });
			entries.push({ type: "custom", customType: type, data, timestamp: new Date().toISOString() });
		},
	};
	extension(pi);
	// Pi creates a new context object for every event; mirror that.
	const makeCtx = (): any => ({
		model,
		thinkingLevel: "medium",
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getBranch: () => entries, getEntries: () => entries, getSessionId: () => "session-1" },
	});
	const emit = async (name: string, event: any = {}) => {
		for (const h of handlers.get(name) ?? []) await h({ type: name, ...event }, makeCtx());
	};
	return { emit, appended, tools };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const model = { provider: "ramp-router", id: "claude-opus-5-5", api: "openai-responses", cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 } };
const usage = { input: 500, output: 10, cacheRead: 100_000, cacheWrite: 0 };

test("expired cache appends one display-only reminder", async () => {
	const at = Date.now() - 10 * 60_000;
	const entries = [{ type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant", provider: model.provider, model: model.id, usage, timestamp: at, stopReason: "stop" } }];
	const h = harness(entries, model);
	await h.emit("session_start", { reason: "startup" });
	await sleep(300);
	assert.equal(h.appended.length, 1);
	assert.equal(h.appended[0]!.type, REMINDER_TYPE);
	assert.match(h.appended[0]!.data.ttlSource, /Anthropic/);
	await h.emit("agent_settled");
	await sleep(300);
	assert.equal(h.appended.length, 1, "no duplicate for same touch");
	await h.emit("session_shutdown");
});

test("forked session-keyed cache waits for fork request", async () => {
	const at = Date.now() - 10 * 60_000;
	const entries = [{ type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant", provider: model.provider, model: model.id, usage, timestamp: at, stopReason: "stop" } }];
	const h = harness(entries, model);
	await h.emit("session_start", { reason: "fork" });
	await sleep(300);
	assert.equal(h.appended.length, 0);
	await h.emit("session_shutdown");
});

test("fresh cache does not remind yet; model switch suppresses", async () => {
	const at = Date.now() - 60_000;
	const entries = [{ type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant", provider: model.provider, model: model.id, usage, timestamp: at, stopReason: "stop" } }];
	const h = harness(entries, model);
	await h.emit("session_start", { reason: "startup" });
	await sleep(300);
	assert.equal(h.appended.length, 0);
	await h.emit("session_shutdown");
});

test("reminder fires after a run settles in a fresh session", async () => {
	const entries: any[] = [];
	const h = harness(entries, model);
	await h.emit("session_start", { reason: "startup" });
	await sleep(200);
	assert.equal(h.appended.length, 0, "no request yet");
	await h.emit("agent_start");
	const at = Date.now() - 6 * 60_000; // older than 5m Anthropic heuristic TTL
	entries.push({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant", provider: model.provider, model: model.id, usage, timestamp: at, stopReason: "stop" } });
	await h.emit("turn_end");
	await h.emit("agent_settled");
	await sleep(300);
	assert.equal(h.appended.length, 1);
	await h.emit("session_shutdown");
});
