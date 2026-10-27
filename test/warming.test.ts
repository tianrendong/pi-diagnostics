import assert from "node:assert/strict";
import test from "node:test";
import extension from "../src/warming.ts";

type Handler = (event: any, ctx: any) => unknown;

interface Options {
	entries?: any[];
	editorText?: string;
	pending?: boolean;
	jev?: number | "error" | "missing" | "noapi";
}

function harness(opts: Options = {}) {
	const handlers = new Map<string, Handler>();
	const pi: any = { on: (name: string, h: Handler) => handlers.set(name, h) };
	extension(pi);
	let classifyCalls = 0;
	const ctx: any = {
		hasUI: true,
		ui: { getEditorText: () => opts.editorText ?? "" },
		hasPendingMessages: () => opts.pending ?? false,
		sessionManager: { getBranch: () => opts.entries ?? [] },
		modelRegistry: opts.jev === "noapi" ? {} : {
			findOfType: () => (opts.jev === "missing" ? undefined : { id: "jev-latest" }),
			classify: async () => {
				classifyCalls++;
				if (opts.jev === "error") throw new Error("boom");
				return { stopReason: "stop", answers: { awaiting: { type: "bool", probability: opts.jev ?? 0 } } };
			},
		},
	};
	return {
		settle: () => handlers.get("agent_settled")!({}, ctx),
		decide: (event: any) => handlers.get("cache_warming_decision")!(event, ctx),
		get classifyCalls() {
			return classifyCalls;
		},
	};
}

const assistant = (text: string, id = "a1") => ({
	type: "message",
	id,
	message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
});

// p=0.5 → 0.5*1 - 0.1 = 0.4 savings; p=0.9 also clears the bar.
const stop = { action: "stop", continuationProbability: 0.15, missCost: 1, warmCost: 0.1 };

test("never overrides warm or streaming decisions", async () => {
	const h = harness({ editorText: "draft" });
	assert.equal(await h.decide({ ...stop, action: "warm" }), undefined);
	assert.equal(await h.decide({ ...stop, continuationProbability: 1 }), undefined);
});

test("warms when the user is drafting or has queued input", async () => {
	assert.deepEqual(await harness({ editorText: "hi" }).decide(stop), { action: "warm" });
	assert.deepEqual(await harness({ pending: true }).decide(stop), { action: "warm" });
});

test("uses Jev verdict when the agent is awaiting a reply", async () => {
	const entries = [assistant("Done. Want me to open a PR")];
	assert.deepEqual(await harness({ entries, jev: 0.8 }).decide(stop), { action: "warm" });
	assert.equal(await harness({ entries, jev: 0.2 }).decide(stop), undefined);
});

test("falls back to the question heuristic when Jev is unavailable", async () => {
	for (const jev of ["missing", "error", "noapi"] as const) {
		assert.deepEqual(await harness({ entries: [assistant("Proceed?")], jev }).decide(stop), { action: "warm" });
		assert.equal(await harness({ entries: [assistant("All done.")], jev }).decide(stop), undefined);
	}
});

test("respects the minimum expected savings", async () => {
	const h = harness({ editorText: "hi" });
	assert.equal(await h.decide({ ...stop, missCost: 0.05, warmCost: 0.01 }), undefined);
});

test("ignores turns that end with a user message or non-stop reason", async () => {
	const user = { type: "message", id: "u1", message: { role: "user", content: "hi" } };
	assert.equal(await harness({ entries: [assistant("Proceed?"), user], jev: 0.9 }).decide(stop), undefined);
	const aborted = { ...assistant("Proceed?"), message: { ...assistant("Proceed?").message, stopReason: "aborted" } };
	assert.equal(await harness({ entries: [aborted], jev: 0.9 }).decide(stop), undefined);
});

test("classifies once per final message", async () => {
	const h = harness({ entries: [assistant("Proceed?")], jev: 0.9 });
	h.settle();
	await h.decide(stop);
	await h.decide(stop);
	assert.equal(h.classifyCalls, 1);
});
