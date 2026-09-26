import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

const STATUS_KEY = "pi-diagnostics";
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

  pi.on("message_end", (event, ctx) => {
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

    const unexpectedMiss = (summary.outcome === "miss" && !expected) || droppedTokens !== undefined;
    const shouldNotify = config.notify === "all" || (config.notify === "miss" && unexpectedMiss);
    if (shouldNotify && ctx.hasUI) {
      // Pi prepends "Warning:" to warning-level extension notifications. Keep diagnostics notices
      // informational so the requested stable message starts directly with "Cache miss".
      ctx.ui.notify(formatNotification(summary, droppedTokens), "info");
    }

    return { message: { ...message, diagnostics: [...(message.diagnostics ?? []), diagnostic] } };
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
      ctx.ui.notify(`${header}\n${body}`, "info");
    },
  });
}
