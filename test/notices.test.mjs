import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { default: load } = await jiti.import("../src/index.ts");
const { summarize } = await jiti.import("../src/core.ts");
const NOTICE_TYPE = "pi-diagnostics";
const MISS = { type: "cache_miss", reason: "tools_changed", cache_missed_tokens: 5_000 };
const MISS_TEXT = "Cache miss, provider diagnostics reason: tools_changed";
const plainTheme = { fg: (_color, text) => text };

function harness({ mode = "tui", notify = "miss", enabled = true, manager = SessionManager.inMemory() } = {}) {
  const handlers = new Map();
  const renderers = new Map();
  const notices = [];
  const notifications = [];
  const env = {
    PI_DIAGNOSTICS: enabled ? "1" : "0",
    PI_DIAGNOSTICS_PROVIDERS: "anthropic,openai",
    PI_DIAGNOSTICS_NOTIFY: notify,
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    load({
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: (name, command) => handlers.set(`/${name}`, command),
      registerEntryRenderer: (type, renderer) => renderers.set(type, renderer),
      appendEntry: (customType, data) => {
        const id = manager.appendCustomEntry(customType, data);
        notices.push(manager.getEntry(id));
      },
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    model: { provider: "openai", api: "openai-responses", id: "gpt" },
    sessionManager: manager,
    ui: { notify: (message, level) => notifications.push({ message, level }) },
  };
  return { handlers, renderers, notices, notifications, manager, ctx };
}

function assistant({ raw = MISS, expectedMiss = false, droppedTokens } = {}) {
  return {
    role: "assistant",
    provider: "openai",
    api: "openai-responses",
    model: "gpt",
    responseId: "resp_2",
    content: [{ type: "text", text: "Answer" }],
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 5_000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5_001,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    diagnostics: [{
      type: "openai_prompt_cache_diagnostics",
      timestamp: Date.now(),
      details: {
        ...summarize("openai", raw),
        raw,
        ...(expectedMiss ? { expected: true } : {}),
        ...(droppedTokens === undefined ? {} : { droppedTokens }),
      },
    }],
  };
}

function finishTurn(h, message) {
  // Pi persists the transformed message_end result before dispatching turn_end.
  const messageEntryId = h.manager.appendMessage(message);
  h.handlers.get("turn_end")({ message, messageEntryId, toolResults: [], toolResultEntryIds: [] }, h.ctx);
  return messageEntryId;
}

test("notice survives disk reload, renders once, and stays out of model context", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-diagnostics-notices-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const h = harness({ manager: SessionManager.create(dir, dir) });
  h.manager.appendMessage({ role: "user", content: "Question", timestamp: Date.now() });
  const message = assistant();
  const messageEntryId = finishTurn(h, message);

  assert.equal(h.notices.length, 1);
  const notice = h.notices[0];
  assert.equal(notice.type, "custom");
  assert.equal(notice.customType, NOTICE_TYPE);
  assert.equal(notice.parentId, messageEntryId);
  assert.deepEqual(notice.data, { message: MISS_TEXT });
  assert.deepEqual(h.notifications, [], "entry_appended already renders the TUI notice");

  const file = h.manager.getSessionFile();
  const persisted = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(persisted.filter((entry) => entry.customType === NOTICE_TYPE), [notice]);

  const reopened = SessionManager.open(file, dir);
  const resumed = harness({ manager: reopened });
  await resumed.handlers.get("session_start")({}, resumed.ctx);
  t.after(() => resumed.handlers.get("session_shutdown")({}, resumed.ctx));
  const restored = reopened.getBranch().filter((entry) => entry.customType === NOTICE_TYPE);
  assert.deepEqual(restored, [notice]);
  assert.equal(resumed.notices.length, 0, "loading a session must not append duplicate notices");
  assert.deepEqual(resumed.notifications, []);

  const renderer = resumed.renderers.get(NOTICE_TYPE);
  const component = renderer(restored[0], { expanded: false }, plainTheme);
  assert.equal(component.render(120).join("\n").trim(), MISS_TEXT);
  component.invalidate();
  assert.equal(component.render(120).join("\n").trim(), MISS_TEXT);
  assert.ok(component.render(20).every((line) => visibleWidth(line) <= 20));
  const expanded = renderer(restored[0], { expanded: true }, plainTheme);
  assert.equal(expanded.render(120).join("\n").trim(), MISS_TEXT);

  const context = reopened.buildSessionContext().messages;
  assert.deepEqual(context.map((entry) => entry.role), ["user", "assistant"]);
  assert.deepEqual(context[1], message, "notice must not change the assistant's model-facing content");
});

test("notice follows its active branch and retained compaction history", () => {
  const h = harness();
  const messageEntryId = finishTurn(h, assistant());
  const notice = h.notices[0];
  h.manager.branch(messageEntryId);
  assert.ok(!h.manager.getBranch().some((entry) => entry.id === notice.id));
  h.manager.branch(notice.id);
  h.manager.appendCompaction("Summary", messageEntryId, 5_000);
  assert.equal(h.manager.buildContextEntries().filter((entry) => entry.id === notice.id).length, 1);
  assert.ok(!h.manager.buildSessionContext().messages.some((message) => message.role === "custom"));
});

for (const scenario of [
  { name: "miss mode records unexpected misses", text: MISS_TEXT },
  { name: "miss mode suppresses expected misses", expectedMiss: true },
  { name: "miss mode suppresses cache hits", raw: { type: "cache_hit" } },
  { name: "miss mode suppresses unavailable without a drop", raw: { type: "unavailable" } },
  {
    name: "miss mode records unavailable with a drop", raw: { type: "unavailable" }, droppedTokens: 97_000,
    text: "Cache miss, provider diagnostics reason: unavailable",
  },
  { name: "all mode records expected misses", notify: "all", expectedMiss: true, text: MISS_TEXT },
  { name: "all mode records cache hits", notify: "all", raw: { type: "cache_hit" }, text: "Provider diagnostics result: cache hit" },
  { name: "all mode records missing diagnostics", notify: "all", raw: null, text: "Provider diagnostics result: no diagnostics returned" },
  { name: "off mode records no notices", notify: "off", droppedTokens: 97_000 },
  { name: "disabled extension records no notices", enabled: false, notify: "all" },
]) {
  test(scenario.name, () => {
    const h = harness(scenario);
    const message = assistant(scenario);
    finishTurn(h, message);
    assert.deepEqual(h.notices.map((entry) => entry.data.message), scenario.text ? [scenario.text] : []);
    assert.deepEqual(h.notifications, []);
    assert.deepEqual(h.manager.buildSessionContext().messages, [message], "raw diagnostics remain intact");
  });
}

for (const mode of ["json", "print", "rpc"]) {
  test(`${mode} mode persists notices without requiring terminal UI`, () => {
    const h = harness({ mode });
    finishTurn(h, assistant());
    assert.deepEqual(h.notices.map((entry) => entry.data.message), [MISS_TEXT]);
    assert.deepEqual(h.notifications, mode === "rpc" ? [{ message: MISS_TEXT, level: "info" }] : []);
  });
}

test("/diagnostics output is durable even when automatic notices are off", async () => {
  const h = harness({ notify: "off" });
  finishTurn(h, assistant());
  assert.equal(h.notices.length, 0);
  await h.handlers.get("/diagnostics").handler("", h.ctx);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].customType, NOTICE_TYPE);
  assert.match(h.notices[0].data.message, /Provider cache diagnostics: on for openai\/gpt/);
  assert.match(h.notices[0].data.message, /gpt: miss tools_changed/);
  assert.deepEqual(h.notifications, []);
  assert.equal(h.manager.buildSessionContext().messages.length, 1);
});

test("unrelated diagnostics and non-assistant messages create no notices", () => {
  const h = harness({ notify: "all" });
  finishTurn(h, { role: "user", content: "Question", timestamp: Date.now() });
  const message = assistant();
  message.diagnostics[0].type = "other_extension_diagnostics";
  finishTurn(h, message);
  assert.deepEqual(h.notices, []);
});

test("renderer ignores missing or malformed notice data", () => {
  const h = harness();
  const renderer = h.renderers.get(NOTICE_TYPE);
  for (const data of [undefined, null, {}, { message: 42 }]) {
    assert.equal(renderer({ data }, { expanded: false }, plainTheme), undefined);
  }
});
