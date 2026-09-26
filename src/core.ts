/**
 * Provider prompt-cache diagnostics for pi.
 *
 * Anthropic Messages: https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics
 *   request:  diagnostics: { previous_message_id: string | null }   (every turn; null = opt in)
 *   response: message_start.message.diagnostics
 *
 * OpenAI Responses: https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics
 *   request:  prompt_cache_options: { comparison_response_id: string }   (omit on first turn)
 *   response: response.completed.response.prompt_cache_diagnostics
 *
 * Pure logic lives here so it can be tested without a pi runtime.
 */

export type DiagnosticsKind = "anthropic" | "openai";

export const DIAGNOSTIC_TYPE: Record<DiagnosticsKind, string> = {
  anthropic: "anthropic_cache_diagnostics",
  openai: "openai_prompt_cache_diagnostics",
};

/** Pi API ids whose request payload shape we know how to extend. */
export const API_KIND: Record<string, DiagnosticsKind> = {
  "anthropic-messages": "anthropic",
  "openai-responses": "openai",
  "azure-openai-responses": "openai",
  "openai-codex-responses": "openai",
};

export const DEFAULT_PROVIDERS = ["anthropic", "openai", "ramp-router"];

export interface ModelRef {
  provider: string;
  api: string;
  id: string;
}

export interface Config {
  enabled: boolean;
  /** Provider names allowed to receive diagnostics fields. "*" allows every provider on a supported API. */
  providers: string[];
  /** When to show a UI notification. */
  notify: "miss" | "all" | "off";
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const providers = (env.PI_DIAGNOSTICS_PROVIDERS ?? DEFAULT_PROVIDERS.join(","))
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const notifyRaw = (env.PI_DIAGNOSTICS_NOTIFY ?? "miss").trim().toLowerCase();
  const notify = notifyRaw === "all" || notifyRaw === "off" ? notifyRaw : "miss";
  const enabledRaw = (env.PI_DIAGNOSTICS ?? "1").trim().toLowerCase();
  const enabled = !["0", "false", "off", "no"].includes(enabledRaw);
  return { enabled, providers, notify };
}

/** Returns the diagnostics dialect for this model, or undefined when diagnostics should not be sent. */
export function kindFor(model: ModelRef | undefined, config: Config): DiagnosticsKind | undefined {
  if (!config.enabled || !model) return undefined;
  const kind = API_KIND[model.api];
  if (!kind) return undefined;
  const allowed = config.providers.includes("*") || config.providers.includes(model.provider);
  return allowed ? kind : undefined;
}

// ---------------------------------------------------------------------------
// Baseline selection
// ---------------------------------------------------------------------------

export interface Baseline {
  responseId: string;
  modelId: string;
  /** A compaction/branch summary sits between the baseline and now, so a miss is expected. */
  afterSummary: boolean;
  /** Baseline prompt size (input + cacheRead + cacheWrite); 0 when usage is unknown. */
  promptTokens: number;
}

interface EntryLike {
  type: string;
  message?: {
    role?: string;
    provider?: string;
    api?: string;
    model?: string;
    responseId?: string;
    stopReason?: string;
    usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
  };
}

/**
 * Most recent successful assistant response on the active branch from the same provider + API.
 * Response ids are provider-scoped, so other providers' ids are never used.
 */
export function findBaseline(branch: readonly EntryLike[], model: ModelRef): Baseline | undefined {
  let afterSummary = false;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      afterSummary = true;
      continue;
    }
    const message = entry.type === "message" ? entry.message : undefined;
    if (!message || message.role !== "assistant") continue;
    if (message.provider !== model.provider || message.api !== model.api) continue;
    if (!message.responseId || message.stopReason === "error" || message.stopReason === "aborted") continue;
    const usage = message.usage;
    const promptTokens = usage ? (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) : 0;
    return { responseId: message.responseId, modelId: message.model ?? "", afterSummary, promptTokens };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Request payload injection
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns a payload with diagnostics fields added, or undefined to leave the payload unchanged.
 * `previousId` of undefined means no baseline (first turn).
 */
export function injectDiagnostics(
  payload: unknown,
  kind: DiagnosticsKind,
  previousId: string | undefined,
): JsonRecord | undefined {
  if (!isRecord(payload)) return undefined;

  if (kind === "anthropic") {
    if (!Array.isArray(payload.messages)) return undefined;
    // Don't overwrite a caller that already opted in explicitly.
    if (isRecord(payload.diagnostics)) return undefined;
    return { ...payload, diagnostics: { previous_message_id: previousId ?? null } };
  }

  // OpenAI Responses: records are stored by default; only the comparison needs opting in.
  if (!("input" in payload)) return undefined;
  if (!previousId) return undefined;
  const existing = isRecord(payload.prompt_cache_options) ? payload.prompt_cache_options : {};
  if (typeof existing.comparison_response_id === "string") return undefined;
  return { ...payload, prompt_cache_options: { ...existing, comparison_response_id: previousId } };
}

// ---------------------------------------------------------------------------
// Request sniffing (inside fetch)
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = '"previous_message_id":"';
const OPENAI_KEY = '"comparison_response_id":"';

export interface Probe {
  kind: DiagnosticsKind;
  comparedTo: string;
}

/**
 * Detect a serialized request body carrying one of our comparison ids. JSON keys inside
 * string content are escaped (\"), so an unescaped match is a real top-level-ish key. Callers
 * must still confirm the id was armed by this extension.
 */
export function sniffBody(body: unknown): Probe | undefined {
  if (typeof body !== "string") return undefined;
  for (const [kind, key] of [
    ["anthropic", ANTHROPIC_KEY],
    ["openai", OPENAI_KEY],
  ] as const) {
    const at = body.indexOf(key);
    if (at === -1) continue;
    const start = at + key.length;
    const end = body.indexOf('"', start);
    if (end === -1 || end - start > 256) continue;
    return { kind, comparedTo: body.slice(start, end) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// SSE tap
// ---------------------------------------------------------------------------

export interface RawResult {
  kind: DiagnosticsKind;
  responseId: string;
  /** Raw provider diagnostics value (null when the provider reported none). */
  raw: unknown;
}

const OPENAI_TERMINAL = new Set(["response.completed", "response.incomplete", "response.failed"]);

/**
 * Inspect SSE data lines for the diagnostics-bearing event. Returns a result, "stop" when the
 * relevant event can no longer appear, or undefined to keep reading.
 */
export function inspectSseData(kind: DiagnosticsKind, data: string): RawResult | "stop" | undefined {
  if (kind === "anthropic") {
    // message_start carries diagnostics. Ignore ping and other events until it arrives.
    if (!data.includes('"message_start"')) return undefined;
    const event = safeParse(data);
    if (!isRecord(event) || event.type !== "message_start" || !isRecord(event.message)) return "stop";
    const id = event.message.id;
    if (typeof id !== "string") return "stop";
    return { kind, responseId: id, raw: event.message.diagnostics ?? null };
  }

  // OpenAI: terminal event carries the full response. Cheap substring check before parsing.
  if (!data.includes('"response.completed"') && !data.includes('"response.incomplete"') && !data.includes('"response.failed"')) {
    return undefined;
  }
  const event = safeParse(data);
  if (!isRecord(event) || typeof event.type !== "string" || !OPENAI_TERMINAL.has(event.type)) return undefined;
  if (!isRecord(event.response) || typeof event.response.id !== "string") return "stop";
  return { kind, responseId: event.response.id, raw: event.response.prompt_cache_diagnostics ?? null };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Pass-through stream that forwards every byte unchanged and reports diagnostics once seen.
 * Preserves backpressure and cancellation; inspection errors never affect the stream.
 */
export function createSseTap(
  kind: DiagnosticsKind,
  onResult: (result: RawResult) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;

  const consume = (text: string, final: boolean) => {
    buffer += text;
    let newline = buffer.indexOf("\n");
    while (newline !== -1 && !done) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (final && !done && buffer) handleLine(buffer);
    if (done || final) buffer = "";
  };

  const handleLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data:")) return;
    const outcome = inspectSseData(kind, line.slice(5).trimStart());
    if (outcome === undefined) return;
    done = true;
    if (outcome !== "stop") onResult(outcome);
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (done) return;
      try {
        consume(decoder.decode(chunk, { stream: true }), false);
      } catch {
        done = true;
      }
    },
    flush() {
      if (done) return;
      try {
        consume(decoder.decode(), true);
      } catch {
        // ignore
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export type Outcome = "hit" | "miss" | "pending" | "not_found" | "unavailable" | "none";

export interface Summary {
  outcome: Outcome;
  reason?: string;
  missedTokens?: number;
}

export function summarize(kind: DiagnosticsKind, raw: unknown): Summary {
  if (kind === "anthropic") {
    // null => no divergence (we always send a real previous id when summarizing).
    if (raw === null || raw === undefined) return { outcome: "hit" };
    if (!isRecord(raw)) return { outcome: "unavailable" };
    const reason = raw.cache_miss_reason;
    if (reason === null || reason === undefined) return { outcome: "pending" };
    if (!isRecord(reason) || typeof reason.type !== "string") return { outcome: "unavailable" };
    if (reason.type === "previous_message_not_found") return { outcome: "not_found", reason: reason.type };
    if (reason.type === "unavailable") return { outcome: "unavailable", reason: reason.type };
    const missed = reason.cache_missed_input_tokens;
    return { outcome: "miss", reason: reason.type, ...(typeof missed === "number" ? { missedTokens: missed } : {}) };
  }

  if (!isRecord(raw) || typeof raw.type !== "string") return { outcome: "none" };
  switch (raw.type) {
    case "cache_hit":
      return { outcome: "hit" };
    case "cache_miss": {
      const missed = raw.cache_missed_tokens;
      return {
        outcome: "miss",
        ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
        ...(typeof missed === "number" ? { missedTokens: missed } : {}),
      };
    }
    case "comparison_response_not_found":
      return { outcome: "not_found", reason: raw.type };
    default:
      return { outcome: "unavailable", reason: raw.type };
  }
}

/** Reasons that the conversation itself explains (model switch, compaction). */
export function isExpectedMiss(summary: Summary, baseline: { modelId: string; afterSummary: boolean } | undefined, modelId: string): boolean {
  if (summary.outcome !== "miss" || !baseline) return false;
  if (summary.reason === "model_changed" && baseline.modelId && baseline.modelId !== modelId) return true;
  if (baseline.afterSummary && (summary.reason === "messages_changed" || summary.reason === "input_changed" || summary.reason === "context_compacted")) {
    return true;
  }
  return false;
}

/** Per-turn drops at or below this are cache breakpoint granularity noise (matches pi's native notice). */
const DROP_NOISE_FLOOR_TOKENS = 1024;

/**
 * Tokens from the baseline prompt that were not read from cache this turn, or undefined when
 * cached tokens did not actually drop. A drop means less than half the baseline prompt was read
 * from cache and the shortfall is above the noise floor.
 */
export function cacheDrop(baselinePromptTokens: number, cacheRead: number): number | undefined {
  if (baselinePromptTokens <= 0) return undefined;
  const dropped = baselinePromptTokens - cacheRead;
  if (dropped <= DROP_NOISE_FLOOR_TOKENS || cacheRead >= baselinePromptTokens / 2) return undefined;
  return dropped;
}

export function formatNotification(summary: Summary, droppedTokens?: number): string {
  if (summary.outcome === "miss") {
    return `Cache miss, provider diagnostics reason: ${summary.reason ?? "unknown"}`;
  }
  if (summary.outcome === "unavailable" && droppedTokens !== undefined) {
    return "Cache miss, provider diagnostics reason: unavailable";
  }
  switch (summary.outcome) {
    case "hit":
      return "Provider diagnostics result: cache hit";
    case "pending":
      return "Provider diagnostics result: comparison pending";
    case "not_found":
      return "Provider diagnostics result: comparison response not found";
    case "unavailable":
      return "Provider diagnostics reason: unavailable";
    case "none":
      return "Provider diagnostics result: no diagnostics returned";
  }
}
