import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  cacheDrop,
  createSseTap,
  formatNotification,
  DIAGNOSTIC_TYPE,
  findBaseline,
  injectDiagnostics,
  isExpectedMiss,
  kindFor,
  parseConfig,
  sniffBody,
  summarize,
  type DiagnosticsKind,
  type ModelRef,
  type RawResult,
} from "./core.ts";

/** A request we modified whose response diagnostics should be captured. */
interface Pending {
  kind: DiagnosticsKind;
  modelId: string;
  baselineId: string;
  baselineModelId: string;
  afterSummary: boolean;
  baselinePromptTokens: number;
}

type Captured = RawResult & Pending;

interface Notice {
  message: string;
}

const NOTICE_TYPE = "pi-diagnostics";
const MAX_TRACKED = 64;

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelRef(value: unknown): ModelRef | undefined {
  if (!isObject(value)) return undefined;
  const { provider, api, id } = value;
  if (typeof provider !== "string" || typeof api !== "string" || typeof id !== "string") return undefined;
  return { provider, api, id };
}

function trim<T>(collection: Map<string, T> | Set<T>): void {
  while (collection.size > MAX_TRACKED) {
    const first = collection.keys().next().value;
    if (first === undefined) return;
    collection.delete(first as never);
  }
}

/**
 * Turns on provider prompt-cache diagnostics for Anthropic Messages and OpenAI Responses.
 *
 * Request side: `before_provider_request` adds the provider's opt-in field, referencing the
 * previous assistant response on the active branch.
 * Response side: pi's adapters drop the diagnostics field, so a narrowly scoped fetch wrapper
 * tees only requests this extension armed, reads the diagnostics-bearing SSE event, and
 * `message_end` attaches the result to the assistant message's `diagnostics` array.
 */
export default function (pi: ExtensionAPI) {
  const config = parseConfig(process.env);
  const pending = new Set<Pending>();
  const captured = new Map<string, Captured>();
  let innerFetch: typeof globalThis.fetch | undefined;
  let wrapper: typeof globalThis.fetch | undefined;

  pi.registerEntryRenderer<Notice>(NOTICE_TYPE, (entry, _options, theme) => {
    if (typeof entry.data?.message !== "string") return undefined;
    return new Text(theme.fg("dim", entry.data.message), 1, 0);
  });

  const persistNotice = (message: string, ctx: ExtensionContext) => {
    // Custom entries survive transcript rebuilds without entering model context or starting a turn.
    // TUI renders entry_appended itself; only RPC needs the separate UI notification.
    pi.appendEntry<Notice>(NOTICE_TYPE, { message });
    if (ctx.hasUI && ctx.mode === "rpc") ctx.ui.notify(message, "info");
  };

  const takePending = (body: unknown): Pending | undefined => {
    if (pending.size === 0) return undefined;
    const probe = sniffBody(body);
    if (!probe) return undefined;
    for (const item of pending) {
      if (item.kind === probe.kind && item.baselineId === probe.comparedTo) {
        pending.delete(item);
        return item;
      }
    }
    return undefined;
  };

  const installFetch = () => {
    if (wrapper && globalThis.fetch === wrapper) return;
    const inner = globalThis.fetch;
    innerFetch = inner;
    wrapper = async (input, init) => {
      const match = takePending(init?.body);
      const response = await inner(input, init);
      if (!match || !response.body) return response;
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) return response;

      const body = response.body.pipeThrough(
        createSseTap(match.kind, (raw) => {
          captured.set(raw.responseId, { ...match, ...raw });
          trim(captured);
        }),
      );
      const tapped = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      Object.defineProperty(tapped, "url", { value: response.url });
      return tapped;
    };
    globalThis.fetch = wrapper;
  };

  const uninstallFetch = () => {
    if (wrapper && globalThis.fetch === wrapper && innerFetch) globalThis.fetch = innerFetch;
    wrapper = undefined;
    innerFetch = undefined;
  };

  pi.on("session_start", () => {
    if (config.enabled) installFetch();
  });

  pi.on("session_shutdown", () => {
    uninstallFetch();
    pending.clear();
    captured.clear();
  });

  pi.on("before_provider_request", (event, ctx) => {
    const model = modelRef(ctx.model);
    const kind = kindFor(model, config);
    if (!model || !kind) return undefined;

    // Nested requests on another model (e.g. compaction overrides) are not ours to label.
    const payload = event.payload;
    if (model.api !== "azure-openai-responses" && isObject(payload) && typeof payload.model === "string" && payload.model !== model.id) {
      return undefined;
    }

    const baseline = findBaseline(ctx.sessionManager.getBranch(), model);
    const next = injectDiagnostics(payload, kind, baseline?.responseId);
    if (!next) return undefined;

    if (baseline) {
      // Re-install if pi replaced global fetch after session start (e.g. HTTP settings change).
      installFetch();
      pending.add({
        kind,
        modelId: model.id,
        baselineId: baseline.responseId,
        baselineModelId: baseline.modelId,
        afterSummary: baseline.afterSummary,
        baselinePromptTokens: baseline.promptTokens,
      });
      trim(pending);
    }
    return next;
  });

  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant" || !message.responseId) return undefined;
    const result = captured.get(message.responseId);
    if (!result) return undefined;
    captured.delete(message.responseId);

    const summary = summarize(result.kind, result.raw);
    const expected = isExpectedMiss(
      summary,
      { modelId: result.baselineModelId, afterSummary: result.afterSummary },
      result.modelId,
    );
    // `unavailable` alone says nothing about hit/miss; only surface it when cached tokens actually
    // dropped versus the baseline. Model switches and compaction explain drops, so skip those.
    const explainedDrop = result.afterSummary || (result.baselineModelId !== "" && result.baselineModelId !== result.modelId);
    const droppedTokens =
      summary.outcome === "unavailable" && !explainedDrop
        ? cacheDrop(result.baselinePromptTokens, message.usage.cacheRead)
        : undefined;

    const diagnostic = {
      type: DIAGNOSTIC_TYPE[result.kind],
      timestamp: Date.now(),
      details: {
        outcome: summary.outcome,
        ...(summary.reason ? { reason: summary.reason } : {}),
        ...(summary.missedTokens !== undefined ? { missedTokens: summary.missedTokens } : {}),
        comparedTo: result.baselineId,
        ...(expected ? { expected: true } : {}),
        ...(droppedTokens !== undefined ? { droppedTokens } : {}),
        cacheRead: message.usage.cacheRead,
        input: message.usage.input,
        raw: (result.raw ?? null) as never,
      },
    };

    return { message: { ...message, diagnostics: [...(message.diagnostics ?? []), diagnostic] } };
  });

  pi.on("turn_end", (event, ctx) => {
    // message_end runs before Pi persists the assistant. Wait for turn_end so notices remain
    // after their response in both the live transcript and restored session history.
    const message = event.message;
    if (!config.enabled || config.notify === "off" || message.role !== "assistant") return;
    for (const diagnostic of message.diagnostics ?? []) {
      const kind = diagnostic.type === DIAGNOSTIC_TYPE.anthropic ? "anthropic"
        : diagnostic.type === DIAGNOSTIC_TYPE.openai ? "openai" : undefined;
      const details = diagnostic.details;
      if (!kind || !isObject(details)) continue;
      const summary = summarize(kind, details.raw);
      const droppedTokens = typeof details.droppedTokens === "number" ? details.droppedTokens : undefined;
      const unexpectedMiss = (summary.outcome === "miss" && details.expected !== true) || droppedTokens !== undefined;
      if (config.notify === "all" || unexpectedMiss) {
        persistNotice(formatNotification(summary, droppedTokens), ctx);
      }
    }
  });

  pi.registerCommand("diagnostics", {
    description: "Show provider prompt-cache diagnostics for recent turns",
    handler: async (_args, ctx) => {
      const types = new Set(Object.values(DIAGNOSTIC_TYPE));
      const lines: string[] = [];
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        const message = entry.message;
        for (const diagnostic of message.diagnostics ?? []) {
          if (!types.has(diagnostic.type as never)) continue;
          const d = (diagnostic.details ?? {}) as Record<string, unknown>;
          const reason = d.reason ? ` ${d.reason}` : "";
          const expected = d.expected ? " (expected)" : "";
          const dropped = typeof d.droppedTokens === "number" ? " · cache miss, diagnostics unavailable" : "";
          lines.push(`${message.model}: ${d.outcome}${reason}${expected}${dropped}`);
        }
      }
      const model = modelRef(ctx.model);
      const active = kindFor(model, config) ? "on" : "off";
      const header = `Provider cache diagnostics: ${active} for ${model ? `${model.provider}/${model.id}` : "no model"} (providers: ${config.providers.join(",")})`;
      const body = lines.length ? lines.slice(-15).join("\n") : "No diagnostics recorded on this branch yet.";
      persistNotice(`${header}\n${body}`, ctx);
    },
  });
}
