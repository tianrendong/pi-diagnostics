import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNativeNoticeSetting, detectNativeMiss, isNativeNoticeShown } from "../src/native.ts";
// Pi does not export cache-stats; import the built file directly to pin parity.
import { detectCacheMiss } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/cache-stats.js";

const T0 = Date.parse("2025-01-01T00:00:00Z");
const models = { getModel: () => ({ cost: { cacheRead: 0.3 } }) };
const price = () => 0.3;

function assistant(input: number, cacheRead: number, cacheWrite: number, { at = T0, model = "claude" } = {}) {
	const cost = { input: input * 3e-6, output: 0, cacheRead: cacheRead * 0.3e-6, cacheWrite: cacheWrite * 3.75e-6, total: 0 };
	return {
		role: "assistant",
		provider: "anthropic",
		model,
		timestamp: at,
		usage: { input, output: 1, cacheRead, cacheWrite, totalTokens: input + cacheRead + cacheWrite + 1, cost },
	};
}
const msg = (message: object) => ({ type: "message", message });

const scenarios: Array<{ name: string; entries: object[]; message: ReturnType<typeof assistant> }> = [
	{ name: "first turn", entries: [], message: assistant(50_000, 0, 0) },
	{ name: "warm hit", entries: [msg(assistant(10, 0, 60_000))], message: assistant(10, 60_000, 500) },
	{ name: "full miss", entries: [msg(assistant(10, 0, 60_000))], message: assistant(10, 0, 61_000, { at: T0 + 600_000 }) },
	{ name: "small miss", entries: [msg(assistant(10, 0, 6_000))], message: assistant(10, 0, 6_500) },
	{ name: "noise floor", entries: [msg(assistant(10, 0, 60_000))], message: assistant(10, 59_000, 900) },
	{ name: "model switch", entries: [msg(assistant(10, 0, 60_000))], message: assistant(60_000, 0, 0, { model: "other" }) },
	{ name: "after compaction", entries: [msg(assistant(10, 0, 60_000)), { type: "compaction" }], message: assistant(10, 0, 20_000) },
	{ name: "no cache ever", entries: [msg(assistant(60_000, 0, 0))], message: assistant(60_000, 0, 0) },
	{
		name: "cache warm usage",
		entries: [
			msg(assistant(10, 0, 60_000)),
			{
				type: "usage", kind: "cache_warm", provider: "anthropic", model: "claude", timestamp: new Date(T0 + 240_000).toISOString(),
				usage: { input: 1, output: 0, cacheRead: 60_000, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
		],
		message: assistant(10, 0, 60_000, { at: T0 + 540_000 }),
	},
];

for (const scenario of scenarios) {
	test(`detectNativeMiss matches Pi: ${scenario.name}`, () => {
		const ours = detectNativeMiss(scenario.entries as never, scenario.message, price);
		const pi = detectCacheMiss(scenario.entries as never, scenario.message as never, models as never);
		assert.deepEqual(ours, pi);
	});
}

test("isNativeNoticeShown mirrors Pi's display threshold", () => {
	assert.equal(isNativeNoticeShown(undefined), false);
	assert.equal(isNativeNoticeShown({ missedTokens: 19_999, missedCost: 0.09, idleMs: 0, modelChanged: false }), false);
	assert.equal(isNativeNoticeShown({ missedTokens: 20_000, missedCost: 0, idleMs: 0, modelChanged: false }), true);
	assert.equal(isNativeNoticeShown({ missedTokens: 5_000, missedCost: 0.1, idleMs: 0, modelChanged: false }), true);
});

test("native notice setting: project overrides global only when trusted", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-diagnostics-native-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	});
	const agentDir = join(dir, "agent");
	const cwd = join(dir, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const setting = createNativeNoticeSetting(1_000);
	assert.equal(setting.enabled(0), false, "default off");

	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ showCacheMissNotices: true }));
	assert.equal(setting.enabled(500), false, "cached within ttl");
	assert.equal(setting.enabled(1_500), true, "re-read after ttl");

	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ showCacheMissNotices: false }));
	setting.setScope({ cwd, projectTrusted: false });
	assert.equal(setting.enabled(1_600), true, "untrusted project ignored");
	setting.setScope({ cwd, projectTrusted: true });
	assert.equal(setting.enabled(1_700), false, "trusted project overrides");
});
