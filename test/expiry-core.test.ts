import assert from "node:assert/strict";
import test from "node:test";
import {
	inspectPayload,
	cacheKeyScope,
	predictPiWarming,
	resolveTtl,
	scanBranch,
	evaluate,
	REMINDER_TYPE,
} from "../src/expiry-core.ts";

const model = {
	provider: "anthropic",
	id: "claude-sonnet",
	api: "anthropic-messages",
	promptCache: { short: 300, long: 3600 },
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};
const iso = (ms: number) => new Date(ms).toISOString();
const usage = { input: 1000, output: 10, cacheRead: 20_000, cacheWrite: 0 };

 test("provider payload retention takes precedence", () => {
	assert.deepEqual(inspectPayload({ prompt_cache_retention: "24h" }), {
		retention: "long",
		ttlMs: 86_400_000,
		source: "prompt_cache_retention=24h",
	});
	assert.equal(inspectPayload({ prompt_cache_options: { mode: "explicit" } }).retention, "none");
	assert.equal(cacheKeyScope({ ...model, api: "openai-responses" }, inspectPayload({ prompt_cache_key: "fork-session" })), "session");
});

test("warming prediction matches Pi safety gates", () => {
	assert.equal(predictPiWarming("off", model, "high", undefined).eligible, false);
	assert.equal(predictPiWarming("idle", model, "high", undefined).eligible, true);
	assert.equal(predictPiWarming("streaming", { ...model, promptCache: undefined }, "high", undefined).eligible, false);
});

test("warming activity postpones expiry", () => {
	const requestAt = Date.now() - 400_000;
	const warmAt = requestAt + 290_000;
	const scan = scanBranch([
		{ type: "message", timestamp: iso(requestAt), message: { role: "assistant", provider: model.provider, model: model.id, usage, timestamp: requestAt } },
		{ type: "usage", timestamp: iso(warmAt), kind: "cache_warm", provider: model.provider, model: model.id },
	]);
	const ttl = resolveTtl({ model });
	assert(ttl);
	const result = evaluate({ scan, model, ttl, warming: { mode: "idle", eligible: true, idle: true, ttlMs: ttl.ttlMs } });
	assert(result);
	assert.equal(result.lastTouchAt, warmAt);
	assert.equal(result.warmCount, 1);
});

test("system/tool-loadout transition invalidates old cache baseline", () => {
	const now = Date.now() - 400_000;
	const scan = scanBranch([
		{ type: "message", timestamp: iso(now), message: { role: "assistant", provider: model.provider, model: model.id, usage, timestamp: now } },
		{ type: "message", timestamp: iso(now + 1), message: { role: "system" } },
	]);
	assert.equal(scan.contextReset, true);
});

test("reminder entry does not suppress reminder after later warming", () => {
	const now = Date.now() - 700_000;
	const scan = scanBranch([
		{ type: "message", timestamp: iso(now), message: { role: "assistant", provider: model.provider, model: model.id, usage, timestamp: now } },
		{ type: "usage", timestamp: iso(now + 400_000), kind: "cache_warm", provider: model.provider, model: model.id },
		{ type: "custom", timestamp: iso(now + 301_000), customType: REMINDER_TYPE, data: { lastTouchAt: now } },
	]);
	assert.equal(scan.remindedForTouchAt, now);
	assert.equal(scan.warmAts.length, 1);
});

test("requests on an abandoned child branch keep the shared prefix warm", () => {
	const t0 = Date.now() - 7 * 60_000; // branch's own last request: expired
	const t1 = Date.now() - 2 * 60_000; // abandoned branch request: fresh
	const asst = (id: string, parentId: string | null, at: number) => ({
		id, parentId, type: "message", timestamp: iso(at),
		message: { role: "assistant", provider: model.provider, model: model.id, usage, timestamp: at, stopReason: "stop" },
	});
	const a = asst("a", null, t0);
	const u = { id: "u", parentId: "a", type: "message", timestamp: iso(t1 - 1), message: { role: "user" } };
	const b = asst("b", "u", t1);
	const scan = scanBranch([a], { allEntries: [a, u, b] });
	assert.equal(scan.relatedRequestAt, t1);
	const ttl = resolveTtl({ model });
	assert(ttl);
	const result = evaluate({ scan, model, ttl, warming: { mode: "off", eligible: false, idle: false } });
	assert(result);
	assert.equal(result.lastTouchAt, t1);
	assert(result.expiresAt > Date.now(), "not expired");
});

test("old stored warming wording renders in current style", async () => {
	const { displayWarming } = await import("../src/expiry-core.ts");
	assert.equal(displayWarming("pi warming inactive (model has no promptCache.short)"), "Not available for this model");
	assert.equal(displayWarming("pi warming inactive (cacheWarming=off)"), "Off in settings");
	assert.equal(displayWarming("Not available for this model"), "Not available for this model");
});

test("reminder wording always hedges expiry", async () => {
	const { buildReminder, reminderView } = await import("../src/expiry-core.ts");
	const openai = { provider: "openai", id: "gpt-5", api: "openai-responses", cost: { input: 1, output: 8, cacheRead: 0.1, cacheWrite: 0 } };
	const openaiTtl = resolveTtl({ model: openai });
	assert.equal(openaiTtl?.ttlMs, 30 * 60_000);
	assert.match(openaiTtl?.source ?? "", /observed ~30m/);
	const codex = { ...openai, api: "openai-codex-responses", provider: "openai-codex" };
	assert.equal(resolveTtl({ model: codex })?.ttlMs, 40 * 60_000);
	assert.equal(resolveTtl({ model: codex, envRetention: "long" })?.ttlMs, 24 * 60 * 60_000);
	assert.equal(resolveTtl({ model: { ...openai, provider: "ramp-router", id: "claude-opus-5-5" } })?.ttlMs, 5 * 60_000);

	const ev = { lastRequestAt: 0, lastTouchAt: 0, expiresAt: 600_000, checkAt: 600_000, warmCount: 0, warmingSummary: "Did not refresh" };
	const title = "Prompt cache may have expired. Now is a cheaper time to /compact, switch model, or change tool/skill loadout.";
	assert.equal(reminderView(buildReminder(openai, openaiTtl!, ev)).title, title);
	const anthropicTtl = resolveTtl({ model });
	assert.equal(reminderView(buildReminder(model, anthropicTtl!, ev)).title, title);
});
