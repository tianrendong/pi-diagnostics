import assert from "node:assert/strict";
import test from "node:test";
import { cacheKeyScope, prefixCacheMode, scanBranch, type EntryLike } from "../src/expiry-core.ts";

const min = 60_000;
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const usage = { input: 10, output: 10, cacheRead: 50_000, cacheWrite: 100 };
const P = "router";
const M = "claude-x";

const asst = (id: string, parentId: string | null, at: number, model = M): EntryLike => ({
	id, parentId, type: "message", timestamp: iso(at),
	message: { role: "assistant", provider: P, model, usage, timestamp: at, stopReason: "toolUse" },
});
const msg = (id: string, parentId: string | null, role: string, at: number): EntryLike => ({
	id, parentId, type: "message", timestamp: iso(at), message: { role, timestamp: at },
});
const warm = (id: string, parentId: string, at: number): EntryLike => ({
	id, parentId, type: "usage", kind: "cache_warm", provider: P, model: M, timestamp: iso(at),
});

/** Path from root to `leaf` in `all`. */
function branchTo(all: EntryLike[], leaf: string): EntryLike[] {
	const byId = new Map(all.map((e) => [e.id!, e]));
	const out: EntryLike[] = [];
	for (let e = byId.get(leaf); e; e = e.parentId ? byId.get(e.parentId) : undefined) out.unshift(e);
	return out;
}

/*
 *  u0 ─ a1 ─ u1 ─ a2 (current leaf, old)
 *        └── u9 ─ a9 (recent; forked ABOVE a2 → shares only through a1)
 */
test("recent request on a branch that forked above the last request is ignored", () => {
	const all = [
		msg("u0", null, "user", NOW - 30 * min),
		asst("a1", "u0", NOW - 29 * min),
		msg("u1", "a1", "user", NOW - 20 * min),
		asst("a2", "u1", NOW - 20 * min),
		msg("u9", "a1", "user", NOW - 1 * min),
		asst("a9", "u9", NOW - 1 * min),
	];
	for (const mode of ["automatic", "breakpoint"] as const) {
		const scan = scanBranch(branchTo(all, "a2"), { allEntries: all, mode });
		assert.equal(scan.lastRequest?.id, "a2");
		assert.equal(scan.relatedRequestAt, undefined, mode);
	}
});

/*
 *  u0 ─ a1 (leaf) ─ u2 ─ r1 ─ t1 ─ r2 ─ t2 ─ r3   (abandoned, long tool loop)
 */
function sideLoop(): EntryLike[] {
	return [
		msg("u0", null, "user", NOW - 40 * min),
		asst("a1", "u0", NOW - 40 * min),
		msg("u2", "a1", "user", NOW - 20 * min),
		asst("r1", "u2", NOW - 20 * min),
		msg("t1", "r1", "toolResult", NOW - 10 * min),
		asst("r2", "t1", NOW - 10 * min),
		msg("t2", "r2", "toolResult", NOW - 2 * min),
		asst("r3", "t2", NOW - 2 * min),
	];
}

test("automatic prefix caches: any deeper request refreshes the shared prefix", () => {
	const all = sideLoop();
	const scan = scanBranch(branchTo(all, "a1"), { allEntries: all, mode: "automatic" });
	assert.equal(scan.relatedRequestAt, NOW - 2 * min);
});

test("anthropic breakpoints: only the first request past the fork refreshes our entry", () => {
	const all = sideLoop();
	const scan = scanBranch(branchTo(all, "a1"), { allEntries: all, mode: "breakpoint" });
	assert.equal(scan.relatedRequestAt, NOW - 20 * min);
});

test("breakpoint mode: warm before first side request counts, warm after it does not", () => {
	const base = sideLoop();
	const early = [...base, warm("w1", "u2", NOW - 19 * min)];
	assert.deepEqual(scanBranch(branchTo(early, "a1"), { allEntries: early, mode: "breakpoint" }).warmAts, [NOW - 19 * min]);
	const late = [...base, warm("w2", "t2", NOW - 1 * min)];
	assert.deepEqual(scanBranch(branchTo(late, "a1"), { allEntries: late, mode: "breakpoint" }).warmAts, []);
	assert.deepEqual(scanBranch(branchTo(late, "a1"), { allEntries: late, mode: "automatic" }).warmAts, [NOW - 1 * min]);
});

test("side branch past a compaction, system update, or shared-prefix edit is ignored", () => {
	const mk = (breaker: EntryLike): EntryLike[] => [
		msg("u0", null, "user", NOW - 40 * min),
		asst("a1", "u0", NOW - 40 * min),
		breaker,
		msg("u2", "x", "user", NOW - 2 * min),
		asst("r1", "u2", NOW - 2 * min),
	];
	const breakers: EntryLike[] = [
		{ id: "x", parentId: "a1", type: "compaction", timestamp: iso(NOW - 3 * min) },
		msg("x", "a1", "system", NOW - 3 * min),
		{ id: "x", parentId: "a1", type: "context_edit", targetId: "u0", timestamp: iso(NOW - 3 * min) },
	];
	for (const b of breakers) {
		const all = mk(b);
		const scan = scanBranch(branchTo(all, "a1"), { allEntries: all, mode: "automatic" });
		assert.equal(scan.relatedRequestAt, undefined, b.type + (b.message?.role ?? ""));
	}
	// An edit of something that exists only on the side branch keeps the shared prefix.
	const ok = mk({ id: "x", parentId: "a1", type: "context_edit", targetId: "zzz", timestamp: iso(NOW - 3 * min) });
	assert.equal(scanBranch(branchTo(ok, "a1"), { allEntries: ok, mode: "automatic" }).relatedRequestAt, NOW - 2 * min);
});

test("side-branch request with a different model does not refresh this model's cache", () => {
	const all = [
		msg("u0", null, "user", NOW - 40 * min),
		asst("a1", "u0", NOW - 40 * min),
		msg("u2", "a1", "user", NOW - 2 * min),
		asst("r1", "u2", NOW - 2 * min, "gpt-other"),
	];
	const scan = scanBranch(branchTo(all, "a1"), { allEntries: all, mode: "automatic" });
	assert.equal(scan.relatedRequestAt, undefined);
});

test("context edit on current branch that rewrites the sent prefix resets; edit of later error does not", () => {
	const base = [msg("u0", null, "user", NOW - 40 * min), asst("a1", "u0", NOW - 40 * min)];
	const rewrite = [...base, { id: "e", parentId: "a1", type: "context_edit", targetId: "u0", timestamp: iso(NOW) } as EntryLike];
	assert.equal(scanBranch(rewrite).contextReset, true);
	const err: EntryLike = { id: "err", parentId: "a1", type: "message", timestamp: iso(NOW), message: { role: "assistant", provider: P, model: M, stopReason: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, timestamp: NOW } };
	const omit = [...base, err, { id: "e", parentId: "err", type: "context_edit", targetId: "err", timestamp: iso(NOW) } as EntryLike];
	const scan = scanBranch(omit);
	assert.equal(scan.contextReset, false);
	assert.equal(scan.lastRequest?.id, "a1");
});

test("cache namespace follows API protocol, not Claude model family", () => {
	assert.equal(cacheKeyScope({ provider: "anthropic", id: "claude-sonnet", api: "anthropic-messages" }), "prefix");
	assert.equal(cacheKeyScope({ provider: "ramp-router", id: "claude-opus-5-5", api: "openai-responses" }), "session");
	assert.equal(prefixCacheMode({ provider: "anthropic", id: "claude-sonnet", api: "anthropic-messages" }), "breakpoint");
	assert.equal(prefixCacheMode({ provider: "ramp-router", id: "claude-opus-5-5", api: "openai-responses" }), "automatic");
});

test("session-keyed fork ignores copied parent request and warms", () => {
	const parentAt = NOW - 10 * min;
	const scan = scanBranch([
		{ id: "a1", parentId: null, type: "message", timestamp: iso(parentAt), message: { role: "assistant", provider: P, model: M, usage, timestamp: parentAt, stopReason: "stop" } },
	], { namespaceStartAt: NOW - min });
	assert.equal(scan.inheritedFrom, NOW - min);
	assert.deepEqual(scan.warmAts, []);
});
