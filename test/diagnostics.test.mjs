import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const core = await jiti.import("../src/core.ts");
const { default: load } = await jiti.import("../src/index.ts");

const anthropic = { provider: "anthropic", api: "anthropic-messages", id: "claude" };
const openai = { provider: "openai", api: "openai-responses", id: "gpt" };

test("defaults only enable direct anthropic/openai providers", () => {
  const config = core.parseConfig({});
  assert.equal(core.kindFor(anthropic, config), "anthropic");
  assert.equal(core.kindFor(openai, config), "openai");
  assert.equal(core.kindFor({ ...openai, provider: "ramp-router" }, config), "openai");
  assert.equal(core.kindFor({ ...openai, provider: "other-router" }, config), undefined);
});

test("injects provider opt-in fields", () => {
  assert.deepEqual(core.injectDiagnostics({ messages: [] }, "anthropic", undefined).diagnostics, { previous_message_id: null });
  assert.equal(core.injectDiagnostics({ input: [] }, "openai", undefined), undefined);
  assert.deepEqual(
    core.injectDiagnostics({ input: [], prompt_cache_options: { ttl: "30m" } }, "openai", "resp_1").prompt_cache_options,
    { ttl: "30m", comparison_response_id: "resp_1" },
  );
});

test("baseline skips failed messages and marks compaction", () => {
  const branch = [
    { type: "message", message: { role: "assistant", ...anthropic, model: "claude", responseId: "msg_1", stopReason: "stop" } },
    { type: "compaction" },
    { type: "message", message: { role: "assistant", ...anthropic, model: "claude", responseId: "msg_2", stopReason: "error" } },
  ];
  assert.deepEqual(core.findBaseline(branch, anthropic), { responseId: "msg_1", modelId: "claude", afterSummary: true, promptTokens: 0 });
});

test("cacheDrop only reports real drops above noise floor", () => {
  assert.equal(core.cacheDrop(0, 0), undefined);
  assert.equal(core.cacheDrop(97_000, 97_000), undefined);
  assert.equal(core.cacheDrop(97_000, 60_000), undefined);
  assert.equal(core.cacheDrop(1_000, 0), undefined);
  assert.equal(core.cacheDrop(97_000, 0), 97_000);
});

test("summarizes provider results", () => {
  assert.deepEqual(core.summarize("anthropic", null), { outcome: "hit" });
  assert.deepEqual(core.summarize("anthropic", { cache_miss_reason: null }), { outcome: "pending" });
  assert.deepEqual(core.summarize("openai", { type: "cache_miss", reason: "tools_changed", cache_missed_tokens: 5 }), {
    outcome: "miss",
    reason: "tools_changed",
    missedTokens: 5,
  });
});

test("SSE tap forwards bytes and reports split OpenAI terminal event", async () => {
  const seen = [];
  const event = 'data: {"type":"response.completed","response":{"id":"resp_2","prompt_cache_diagnostics":{"type":"cache_hit"}}}\n\n';
  const source = new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(event);
      controller.enqueue(bytes.slice(0, 20));
      controller.enqueue(bytes.slice(20));
      controller.close();
    },
  });
  const text = await new Response(source.pipeThrough(core.createSseTap("openai", (r) => seen.push(r)))).text();
  assert.equal(text, event);
  assert.deepEqual(seen, [{ kind: "openai", responseId: "resp_2", raw: { type: "cache_hit" } }]);
});

test("extension end-to-end attaches diagnostics to assistant message", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let sent;
  globalThis.fetch = async (_input, init) => {
    sent = JSON.parse(init.body);
    return new Response(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","diagnostics":{"cache_miss_reason":{"type":"system_changed","cache_missed_input_tokens":1200}}}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  };

  const handlers = new Map();
  load({ on: (name, fn) => handlers.set(name, fn), registerCommand: (name, def) => handlers.set(`/${name}`, def) });
  const notices = [];
  const branch = [{ type: "message", message: { role: "assistant", ...anthropic, model: "claude", responseId: "msg_1", stopReason: "stop" } }];
  const ctx = {
    model: anthropic,
    hasUI: true,
    sessionManager: { getBranch: () => branch },
    ui: { notify: (message, level) => notices.push({ message, level }) },
  };

  await handlers.get("session_start")({}, ctx);
  const payload = handlers.get("before_provider_request")({ payload: { model: "claude", messages: [] } }, ctx);
  await (await globalThis.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify(payload) })).text();
  assert.deepEqual(sent.diagnostics, { previous_message_id: "msg_1" });

  const result = handlers.get("message_end")(
    { message: { role: "assistant", ...anthropic, model: "claude", responseId: "msg_2", usage: { cacheRead: 0, input: 10 } } },
    ctx,
  );
  assert.equal(result.message.diagnostics[0].type, "anthropic_cache_diagnostics");
  assert.equal(result.message.diagnostics[0].details.reason, "system_changed");
  assert.equal(notices[0].level, "info");
  assert.equal(notices[0].message, "Cache miss, provider diagnostics reason: system_changed");
  await handlers.get("session_shutdown")({}, ctx);
});

async function runOpenAiTurn(t, { raw, cacheRead, baselineModel = "gpt", baselinePrompt = 97_000, branchExtra = [] }) {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const event = { type: "response.completed", response: { id: "resp_2", prompt_cache_diagnostics: raw } };
  globalThis.fetch = async () =>
    new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });

  const handlers = new Map();
  load({ on: (name, fn) => handlers.set(name, fn), registerCommand: (name, def) => handlers.set(`/${name}`, def) });
  const notices = [];
  const branch = [
    {
      type: "message",
      message: {
        role: "assistant",
        ...openai,
        model: baselineModel,
        responseId: "resp_1",
        stopReason: "stop",
        usage: { input: 3, cacheRead: baselinePrompt - 3, cacheWrite: 0 },
      },
    },
    ...branchExtra,
  ];
  const ctx = {
    model: openai,
    hasUI: true,
    sessionManager: { getBranch: () => branch },
    ui: { notify: (message, level) => notices.push({ message, level }) },
  };
  await handlers.get("session_start")({}, ctx);
  const payload = handlers.get("before_provider_request")({ payload: { model: "gpt", input: [] } }, ctx);
  await (await globalThis.fetch("https://example.test/v1/responses", { method: "POST", body: JSON.stringify(payload) })).text();
  const result = handlers.get("message_end")(
    { message: { role: "assistant", ...openai, model: "gpt", responseId: "resp_2", usage: { cacheRead, input: 3 } } },
    ctx,
  );
  await handlers.get("session_shutdown")({}, ctx);
  return { notices, details: result.message.diagnostics[0].details };
}

test("unavailable + cached tokens dropped shows concise provider reason", async (t) => {
  const { notices, details } = await runOpenAiTurn(t, { raw: { type: "unavailable" }, cacheRead: 0 });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, "info");
  assert.equal(notices[0].message, "Cache miss, provider diagnostics reason: unavailable");
  assert.equal(details.droppedTokens, 97_000);
  assert.equal(details.docs, undefined);
  assert.equal(details.explanation, undefined);
});

test("unavailable without a cache drop stays quiet", async (t) => {
  const { notices, details } = await runOpenAiTurn(t, { raw: { type: "unavailable" }, cacheRead: 97_000 });
  assert.equal(notices.length, 0);
  assert.equal(details.droppedTokens, undefined);
  assert.equal(details.explanation, undefined);
});

test("unavailable drop after model switch or compaction stays quiet", async (t) => {
  const switched = await runOpenAiTurn(t, { raw: { type: "unavailable" }, cacheRead: 0, baselineModel: "other" });
  assert.equal(switched.notices.length, 0);
  const compacted = await runOpenAiTurn(t, { raw: { type: "unavailable" }, cacheRead: 0, branchExtra: [{ type: "compaction" }] });
  assert.equal(compacted.notices.length, 0);
});
