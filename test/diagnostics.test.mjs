import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const core = await jiti.import("../src/core.ts");
const { default: load } = await jiti.import("../src/index.ts");

const anthropic = { provider: "anthropic", api: "anthropic-messages", id: "claude" };
const openai = { provider: "openai", api: "openai-responses", id: "gpt" };

function loadExtension() {
  const handlers = new Map();
  const notices = [];
  load({
    on: (name, fn) => handlers.set(name, fn),
    registerCommand: (name, def) => handlers.set(`/${name}`, def),
    registerEntryRenderer: () => {},
    appendEntry: (customType, data) => notices.push({ customType, data }),
  });
  return { handlers, notices };
}

test("defaults only enable direct anthropic/openai providers", () => {
  const config = core.parseConfig({});
  assert.equal(core.kindFor(anthropic, config), "anthropic");
  assert.equal(core.kindFor(openai, config), "openai");
  assert.equal(core.kindFor({ ...openai, provider: "ramp-router" }, config), "openai");
  assert.equal(core.kindFor({ ...openai, provider: "other-router" }, config), undefined);
  assert.equal(core.kindFor({ ...anthropic, provider: "ramp-router" }, config), undefined, "router Messages route returns no diagnostics");
});

test("provider entries can be scoped to one dialect", () => {
  const both = core.parseConfig({ PI_DIAGNOSTICS_PROVIDERS: "ramp-router" });
  assert.equal(core.kindFor({ ...anthropic, provider: "ramp-router" }, both), "anthropic");
  assert.equal(core.kindFor({ ...openai, provider: "ramp-router" }, both), "openai");
  const scoped = core.parseConfig({ PI_DIAGNOSTICS_PROVIDERS: "proxy:anthropic" });
  assert.equal(core.kindFor({ ...anthropic, provider: "proxy" }, scoped), "anthropic");
  assert.equal(core.kindFor({ ...openai, provider: "proxy" }, scoped), undefined);
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
  assert.deepEqual(core.summarize("anthropic", null, { cacheDropped: true }), { outcome: "expired" });
  assert.deepEqual(core.summarize("anthropic", undefined), { outcome: "none" }, "absent field is not a hit");
  assert.deepEqual(core.summarize("anthropic", undefined, { cacheDropped: true }), { outcome: "none" });
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

  const { handlers, notices } = loadExtension();
  const branch = [{ type: "message", message: { role: "assistant", ...anthropic, model: "claude", responseId: "msg_1", stopReason: "stop" } }];
  const ctx = {
    model: anthropic,
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => branch, getEntries: () => branch },
    ui: { notify: () => assert.fail("TUI notices must render from session entries") },
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
  assert.equal(notices.length, 0, "wait until the assistant message is persisted");
  handlers.get("turn_end")({ message: result.message }, ctx);
  assert.deepEqual(notices, [{
    customType: "pi-diagnostics",
    data: { message: "Cache miss, provider diagnostics reason: system_changed" },
  }]);
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

  const { handlers, notices } = loadExtension();
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
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => branch, getEntries: () => branch },
    ui: { notify: () => assert.fail("TUI notices must render from session entries") },
  };
  await handlers.get("session_start")({}, ctx);
  const payload = handlers.get("before_provider_request")({ payload: { model: "gpt", input: [] } }, ctx);
  await (await globalThis.fetch("https://example.test/v1/responses", { method: "POST", body: JSON.stringify(payload) })).text();
  const result = handlers.get("message_end")(
    { message: { role: "assistant", ...openai, model: "gpt", responseId: "resp_2", usage: { cacheRead, input: 3 } } },
    ctx,
  );
  assert.equal(notices.length, 0, "wait until the assistant message is persisted");
  handlers.get("turn_end")({ message: result.message }, ctx);
  await handlers.get("session_shutdown")({}, ctx);
  return { notices, details: result.message.diagnostics[0].details };
}

test("unavailable + cached tokens dropped shows concise provider reason", async (t) => {
  const { notices, details } = await runOpenAiTurn(t, { raw: { type: "unavailable" }, cacheRead: 0 });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].customType, "pi-diagnostics");
  assert.equal(notices[0].data.message, "Cache miss, provider diagnostics reason: unavailable");
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

test("Anthropic SSE distinguishes absent diagnostics from explicit null", () => {
  const start = (message) => JSON.stringify({ type: "message_start", message: { id: "msg_2", ...message } });
  assert.equal(core.inspectSseData("anthropic", start({ diagnostics: null })).raw, null);
  const absent = core.inspectSseData("anthropic", start({}));
  assert.equal(absent.responseId, "msg_2");
  assert.equal(absent.raw, undefined);
});

async function runAnthropicTurn(t, { message, cacheRead }) {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const event = { type: "message_start", message: { id: "msg_2", ...message } };
  globalThis.fetch = async () =>
    new Response(`event: message_start\ndata: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  const { handlers, notices } = loadExtension();
  const branch = [{
    type: "message",
    message: {
      role: "assistant", ...anthropic, model: "claude", responseId: "msg_1", stopReason: "stop",
      usage: { input: 2, cacheRead: 100_000, cacheWrite: 500 },
    },
  }];
  const ctx = {
    model: anthropic, mode: "tui", hasUI: true,
    sessionManager: { getBranch: () => branch, getEntries: () => branch },
    ui: { notify: () => assert.fail("TUI notices must render from session entries") },
  };
  await handlers.get("session_start")({}, ctx);
  const payload = handlers.get("before_provider_request")({ payload: { model: "claude", messages: [] } }, ctx);
  await (await globalThis.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify(payload) })).text();
  const result = handlers.get("message_end")(
    { message: { role: "assistant", ...anthropic, model: "claude", responseId: "msg_2", usage: { cacheRead, input: 4 } } },
    ctx,
  );
  handlers.get("turn_end")({ message: result.message }, ctx);
  await handlers.get("session_shutdown")({}, ctx);
  return { notices, details: result.message.diagnostics[0].details };
}

test("Anthropic null with dropped cache reads reports an expired entry, not a hit", async (t) => {
  const { notices, details } = await runAnthropicTurn(t, { message: { diagnostics: null }, cacheRead: 0 });
  assert.equal(details.outcome, "expired");
  assert.equal(details.droppedTokens, 100_502);
  assert.equal(details.raw, null);
  assert.deepEqual(notices.map((n) => n.data.message), ["Cache miss, provider diagnostics: prompt unchanged, cache entry expired"]);
});

test("Anthropic null with warm cache reads stays a quiet hit", async (t) => {
  const { notices, details } = await runAnthropicTurn(t, { message: { diagnostics: null }, cacheRead: 100_500 });
  assert.equal(details.outcome, "hit");
  assert.equal(details.droppedTokens, undefined);
  assert.equal(notices.length, 0);
});

test("missing Anthropic diagnostics field is recorded as none, never as expired", async (t) => {
  const { notices, details } = await runAnthropicTurn(t, { message: {}, cacheRead: 0 });
  assert.equal(details.outcome, "none");
  assert.equal(Object.hasOwn(details, "raw"), false);
  assert.equal(details.droppedTokens, undefined);
  assert.equal(notices.length, 0);
});
