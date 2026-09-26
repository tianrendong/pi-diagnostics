/**
 * Pure logic for the cache-expiry reminder. No runtime imports so it can be
 * unit-tested with plain `node --test`.
 */

export const REMINDER_TYPE = "cache-expiry-reminder";

export type Retention = "none" | "short" | "long";
export type CacheWarmingMode = "off" | "streaming" | "idle";

/** Mirrors pi's cache-warmer constants (dist/core/cache-warmer.js). */
export const PI_IDLE_WARMING_MAX_AGE_MS = 30 * 60_000;
export const PI_MIN_EXPECTED_SAVINGS = 0.05;
/** Time allowed for an in-flight pi warm request to land in the session. */
export const DEFAULT_WARM_GRACE_MS = 20_000;

export interface ModelLike {
	provider: string;
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	promptCache?: { short?: number; long?: number };
	compat?: { forceAdaptiveThinking?: boolean } & Record<string, unknown>;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
}

/** Minimal session entry shape used by the branch scan. */
export interface EntryLike {
	id?: string;
	parentId?: string | null;
	type: string;
	timestamp: string;
	customType?: string;
	data?: unknown;
	targetId?: string;
	kind?: string;
	provider?: string;
	model?: string;
	message?: {
		role: string;
		provider?: string;
		model?: string;
		stopReason?: string;
		usage?: UsageLike;
		timestamp?: number;
	};
}

// ---------------------------------------------------------------------------
// Payload inspection
// ---------------------------------------------------------------------------

export interface PayloadCacheHints {
	retention?: Retention;
	ttlMs?: number;
	source?: string;
	/** Payload carried a session-derived cache key (`prompt_cache_key`/`promptCacheKey`). */
	sessionKeyed?: boolean;
}

/** Parse "5m", "1h", "24h", "300s", "in_memory". */
export function parseDurationMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value * 1000;
	if (typeof value !== "string") return undefined;
	const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(value.trim());
	if (!match) return undefined;
	const n = Number(match[1]);
	const unit = match[2]!.toLowerCase();
	const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
	return n * mult;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Look at the first/last few items only; cache markers live at the edges. */
function edgeItems(arr: unknown, n = 4): unknown[] {
	if (!Array.isArray(arr)) return [];
	if (arr.length <= n * 2) return arr;
	return [...arr.slice(0, n), ...arr.slice(-n)];
}

function findCacheMarkers(payload: Record<string, unknown>): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	const visit = (item: unknown, depth: number) => {
		if (!isRecord(item) || depth > 3) return;
		for (const key of ["cache_control", "cachePoint", "cacheControl"]) {
			const marker = item[key];
			if (isRecord(marker)) out.push(marker);
		}
		for (const key of ["content", "system"]) {
			const inner = item[key];
			if (Array.isArray(inner)) for (const child of edgeItems(inner)) visit(child, depth + 1);
		}
	};
	visit(payload, 0);
	for (const key of ["system", "tools", "messages", "input"]) {
		for (const item of edgeItems(payload[key])) visit(item, 1);
	}
	return out;
}

/**
 * Extract explicit cache-lifetime signals from the final provider payload
 * (after other extensions' `before_provider_request` transforms).
 */
export function inspectPayload(payload: unknown): PayloadCacheHints {
	if (!isRecord(payload)) return {};
	const hints = inspectRetention(payload);
	const key = payload.prompt_cache_key ?? payload.promptCacheKey;
	return typeof key === "string" && key.length > 0 ? { ...hints, sessionKeyed: true } : hints;
}

function inspectRetention(payload: Record<string, unknown>): PayloadCacheHints {
	// OpenAI Responses explicit prompt-cache mode.
	const options = payload.prompt_cache_options;
	if (isRecord(options)) {
		const ttlMs = parseDurationMs(options.ttl);
		if (ttlMs) return { retention: "long", ttlMs, source: `prompt_cache_options.ttl=${String(options.ttl)}` };
		if (options.mode === "explicit") return { retention: "none", source: "prompt_cache_options.mode=explicit" };
	}

	// OpenAI extended retention.
	const retention = payload.prompt_cache_retention;
	if (typeof retention === "string") {
		const ttlMs = parseDurationMs(retention);
		if (ttlMs) return { retention: "long", ttlMs, source: `prompt_cache_retention=${retention}` };
		if (retention === "in_memory") return { retention: "short", source: "prompt_cache_retention=in_memory" };
	}

	// Anthropic cache_control / Bedrock cachePoint.
	const markers = findCacheMarkers(payload);
	if (markers.length > 0) {
		let best: number | undefined;
		for (const marker of markers) {
			const ttl = parseDurationMs(marker.ttl);
			if (ttl !== undefined && (best === undefined || ttl < best)) best = ttl;
		}
		// Anthropic evicts by the shortest breakpoint; unspecified TTL = 5m.
		const hasDefault = markers.some((m) => m.ttl === undefined);
		if (hasDefault) return { retention: "short", source: "cache_control (default ttl)" };
		if (best !== undefined) {
			return { retention: best > 300_000 ? "long" : "short", ttlMs: best, source: `cache_control.ttl` };
		}
	}
	return {};
}

// ---------------------------------------------------------------------------
// TTL resolution
// ---------------------------------------------------------------------------

export type ModelFamily = "anthropic" | "openai" | "google" | "other";

export function modelFamily(model: ModelLike): ModelFamily {
	const hay = `${model.provider}/${model.id}/${model.name ?? ""}`.toLowerCase();
	if (/claude|anthropic/.test(hay)) return "anthropic";
	if (/gemini|google|vertex/.test(hay)) return "google";
	if (/(^|[/\s-])(gpt|o\d|chatgpt|codex)|openai/.test(hay)) return "openai";
	return "other";
}

/**
 * Fallback lifetimes in seconds when model does not declare `promptCache`.
 * These are "likely expired" thresholds, not provider guarantees. Values for
 * OpenAI are calibrated from observed cache-hit rates in local Pi sessions:
 * Responses hits drop sharply after ~30m idle; Codex hits become minority after
 * ~40m. Long retention remains provider's documented 24h tier.
 */
export const FAMILY_TTL_SECONDS: Record<ModelFamily, { short: number; long: number; label: string }> = {
	anthropic: { short: 300, long: 3600, label: "Anthropic default" },
	openai: { short: 1800, long: 86_400, label: "OpenAI automatic cache ~30m" },
	google: { short: 300, long: 3600, label: "Gemini implicit cache" },
	other: { short: 300, long: 3600, label: "generic default" },
};

/**
 * OpenAI protocols show different idle-expiry knees in our session data. Only
 * OpenAI-family models use these; routed Claude/Gemini keep family defaults.
 */
const OPENAI_API_TTL_SECONDS: Record<string, { short: number; long: number; label: string }> = {
	"openai-responses": { short: 1800, long: 86_400, label: "OpenAI Responses observed ~30m" },
	"openai-codex-responses": { short: 2400, long: 86_400, label: "OpenAI Codex observed ~40m" },
};

function fallbackTtl(model: ModelLike, retention: Retention): { seconds: number; label: string } {
	const fam = modelFamily(model);
	const api = fam === "openai" && model.api ? OPENAI_API_TTL_SECONDS[model.api] : undefined;
	const family = FAMILY_TTL_SECONDS[fam];
	const source = api ?? family;
	return { seconds: source[retention === "long" ? "long" : "short"], label: source.label };
}

export interface TtlResolution {
	ttlMs: number;
	retention: Retention;
	source: string;
}

export interface ResolveTtlInput {
	model: ModelLike;
	hints?: PayloadCacheHints;
	lastUsage?: UsageLike;
	envRetention?: string;
	overrides?: Record<string, number>;
}

function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

/** Returns undefined when prompt caching is disabled for the request. */
export function resolveTtl(input: ResolveTtlInput): TtlResolution | undefined {
	const { model, hints, lastUsage, overrides } = input;
	const key = `${model.provider}/${model.id}`;
	for (const [pattern, seconds] of Object.entries(overrides ?? {})) {
		if (typeof seconds === "number" && seconds > 0 && globToRegExp(pattern).test(key)) {
			return { ttlMs: seconds * 1000, retention: "short", source: `config override ${pattern}` };
		}
	}

	if (hints?.retention === "none") return undefined;
	if (hints?.ttlMs) return { ttlMs: hints.ttlMs, retention: hints.retention ?? "short", source: hints.source ?? "request" };

	let retention: Retention = "short";
	let retentionSource = "";
	if (hints?.retention) {
		retention = hints.retention;
		retentionSource = hints.source ?? "request";
	} else if ((lastUsage?.cacheWrite1h ?? 0) > 0) {
		retention = "long";
		retentionSource = "1h cache write observed";
	} else if (input.envRetention === "long") {
		retention = "long";
		retentionSource = "PI_CACHE_RETENTION=long";
	}
	const suffix = retentionSource ? `, ${retentionSource}` : "";

	const declared = model.promptCache?.[retention === "long" ? "long" : "short"];
	if (declared !== undefined && declared > 0) {
		return { ttlMs: declared * 1000, retention, source: `model promptCache.${retention}${suffix}` };
	}
	// Do not manufacture expiry reminders for providers with no cache billing or
	// observed cache tokens. Dynamic routers often omit promptCache metadata but
	// still expose cacheRead pricing, which is enough for the family fallback.
	const cacheKnown = (model.cost?.cacheRead ?? 0) > 0 ||
		(model.cost?.cacheWrite ?? 0) > 0 ||
		(lastUsage?.cacheRead ?? 0) > 0 ||
		(lastUsage?.cacheWrite ?? 0) > 0;
	if (!cacheKnown) return undefined;
	const fallback = fallbackTtl(model, retention);
	return { ttlMs: fallback.seconds * 1000, retention, source: `heuristic: ${fallback.label}${suffix}` };
}

// ---------------------------------------------------------------------------
// Pi cache warming prediction
// ---------------------------------------------------------------------------

export interface WarmingEligibility {
	mode: CacheWarmingMode;
	/** Pi would arm a warming run for requests with this model/settings. */
	eligible: boolean;
	/** Pi keeps warming after the agent settles. */
	idle: boolean;
	reason?: string;
	ttlMs?: number;
}

export function normalizeWarmingMode(value: unknown): CacheWarmingMode {
	return value === "off" || value === "idle" || value === "streaming" ? value : "streaming";
}

/** Replicates pi's `CacheWarmer.start` gating. Economics are observed separately. */
export function predictPiWarming(
	mode: CacheWarmingMode,
	model: ModelLike,
	thinkingLevel: string | undefined,
	envRetention: string | undefined,
): WarmingEligibility {
	if (mode === "off") return { mode, eligible: false, idle: false, reason: "cacheWarming=off" };
	const reasoning = !!model.reasoning && thinkingLevel !== undefined && thinkingLevel !== "off";
	if (reasoning && model.api === "anthropic-messages" && model.compat?.forceAdaptiveThinking !== true) {
		return { mode, eligible: false, idle: false, reason: "budget-thinking request not replayable" };
	}
	const retention = envRetention === "long" ? "long" : "short";
	const seconds = model.promptCache?.[retention];
	if (seconds === undefined) {
		return { mode, eligible: false, idle: false, reason: `model has no promptCache.${retention}` };
	}
	if (seconds * 1000 <= 10_000) return { mode, eligible: false, idle: false, reason: "cache lifetime too short" };
	return { mode, eligible: true, idle: mode === "idle", ttlMs: seconds * 1000 };
}

// ---------------------------------------------------------------------------
// Branch scan
// ---------------------------------------------------------------------------

/**
 * How a provider keeps a cached prefix alive.
 *
 * - `automatic`: prefix/block caches (OpenAI, Gemini implicit, DeepSeek, …).
 *   Any request that resends a prefix reuses and refreshes every block of it,
 *   so a request anywhere below the fork point keeps the shared prefix warm.
 * - `breakpoint`: Anthropic `cache_control`. Each request writes one entry at
 *   its own end and refreshes only the entry it read. Deeper requests on a
 *   side branch read *their* newer breakpoints, so only the first request past
 *   the fork point re-reads (and refreshes) the entry this branch will hit.
 */
export type PrefixCacheMode = "automatic" | "breakpoint";

export function prefixCacheMode(model: ModelLike, hints?: PayloadCacheHints): PrefixCacheMode {
	// Protocol wins over model name. Claude sent through OpenAI Responses uses
	// Pi's session-derived key, not Anthropic breakpoint semantics.
	return cacheKeyScope(model, hints) === "session"
		? "automatic"
		: modelFamily(model) === "anthropic" ? "breakpoint" : "automatic";
}

/**
 * What namespaces a provider cache entry. Decided by wire protocol, not model
 * family: Claude behind an OpenAI Responses router is session-keyed.
 *
 * - `prefix`: cache keyed only by request prefix (Anthropic Messages, Bedrock,
 *   Gemini). A `/fork` resends the same prefix, so it inherits the parent's
 *   cache and parent activity keeps it warm.
 * - `session`: Pi sends `prompt_cache_key = sessionId` (OpenAI Responses,
 *   Codex, Azure, Mistral, OpenAI completions on api.openai.com). `/fork`
 *   gets a new session id, so the fork starts in an empty namespace.
 */
export type CacheKeyScope = "prefix" | "session";

const SESSION_KEYED_APIS = new Set([
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"mistral-conversations",
]);

export function cacheKeyScope(model: ModelLike, hints?: PayloadCacheHints): CacheKeyScope {
	if (hints?.sessionKeyed) return "session";
	if (model.api && SESSION_KEYED_APIS.has(model.api)) return "session";
	if (model.api === "openai-completions" && model.baseUrl?.includes("api.openai.com")) return "session";
	return "prefix";
}

export interface BranchScan {
	lastRequest?: { id?: string; at: number; provider?: string; model?: string; usage?: UsageLike };
	/** Pi cache-warm replays of the prefix this branch will resend. */
	warmAts: number[];
	/**
	 * Newest request on another branch that refreshed this branch's cached
	 * prefix. Provider caches are keyed by prompt content, not Pi branch.
	 * Only requests below this branch's last request qualify: anything that
	 * forked earlier shares a strictly shorter prefix, so most of the next
	 * request would miss anyway.
	 */
	relatedRequestAt?: number;
	/** `lastTouchAt` recorded by the newest reminder on the branch. */
	remindedForTouchAt?: number;
	/**
	 * Start of the current cache namespace (session-keyed caches only). Set when
	 * the last request predates it, i.e. was copied in by `/fork` and populated
	 * the parent session's namespace, not ours.
	 */
	inheritedFrom?: number;
	/** Compaction/summary, system prompt change, or context edit invalidated the last request's prefix. */
	contextReset: boolean;
}

function entryTime(entry: EntryLike): number {
	const t = Date.parse(entry.timestamp);
	return Number.isFinite(t) ? t : 0;
}

function requestTime(entry: EntryLike): number {
	const ts = entry.message?.timestamp;
	return typeof ts === "number" ? ts : entryTime(entry);
}

/** Assistant entries that correspond to a provider request that processed its prompt. */
function isRequest(entry: EntryLike): boolean {
	if (entry.type !== "message" || entry.message?.role !== "assistant") return false;
	const m = entry.message;
	const u = m.usage;
	const promptTokens = u ? u.input + u.cacheRead + u.cacheWrite : 0;
	return !(m.stopReason === "error" && promptTokens === 0);
}

/** Entries after which later requests no longer resend the same prefix. */
function breaksPrefix(entry: EntryLike, sharedIds: ReadonlySet<string>): boolean {
	if (entry.type === "compaction" || entry.type === "branch_summary") return true;
	// Prompt/tool loadout update. Providers without mid-conversation system
	// messages get a whole-transcript checkpoint here, so be conservative.
	if (entry.type === "message" && entry.message?.role === "system") return true;
	// Editing an entry inside the shared prefix rewrites it for later requests.
	if (entry.type === "context_edit" && entry.targetId && sharedIds.has(entry.targetId)) return true;
	return false;
}

export interface ScanOptions {
	/** Whole session tree; enables counting activity on other branches. */
	allEntries?: readonly EntryLike[];
	mode?: PrefixCacheMode;
	/**
	 * Session-keyed caches: when the current session id came into existence.
	 * Requests and warms before it (copied by `/fork`) filled another namespace.
	 */
	namespaceStartAt?: number;
}

export function scanBranch(entries: readonly EntryLike[], options: ScanOptions = {}): BranchScan {
	const mode = options.mode ?? "automatic";
	const warm: { at: number; provider?: string }[] = [];
	const editTargets: string[] = [];
	let remindedForTouchAt: number | undefined;
	let lastRequest: BranchScan["lastRequest"];
	let lastRequestIndex = -1;
	let contextReset = false;

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type === "custom" && entry.customType === REMINDER_TYPE) {
			if (remindedForTouchAt === undefined) {
				const at = (entry.data as { lastTouchAt?: unknown } | undefined)?.lastTouchAt;
				if (typeof at === "number") remindedForTouchAt = at;
			}
			continue;
		}
		if (entry.type === "usage" && entry.kind === "cache_warm") {
			// Warm replays the branch's last request, i.e. exactly our prefix.
			warm.push({ at: entryTime(entry), provider: entry.provider });
			continue;
		}
		if (entry.type === "context_edit" && entry.targetId) {
			editTargets.push(entry.targetId);
			continue;
		}
		if (breaksPrefix(entry, new Set())) {
			contextReset = true;
			break;
		}
		if (isRequest(entry)) {
			const m = entry.message!;
			lastRequest = { id: entry.id, at: requestTime(entry), provider: m.provider, model: m.model, usage: m.usage };
			lastRequestIndex = i;
			break;
		}
	}

	// Ids of everything the last request sent (plus its own output).
	const sharedIds = new Set<string>();
	if (lastRequestIndex >= 0) {
		for (let i = 0; i <= lastRequestIndex; i++) {
			const id = entries[i]!.id;
			if (id) sharedIds.add(id);
		}
	}
	// An edit made after the last request to something it had sent changes
	// the prefix the next request resends.
	if (editTargets.some((id) => sharedIds.has(id))) contextReset = true;

	let relatedRequestAt: number | undefined;
	if (lastRequest?.id && options.allEntries && !contextReset) {
		const onBranch = new Set(entries.map((e) => e.id).filter((id): id is string => !!id));
		const children = new Map<string, EntryLike[]>();
		for (const e of options.allEntries) {
			if (!e.parentId) continue;
			const list = children.get(e.parentId);
			if (list) list.push(e);
			else children.set(e.parentId, [e]);
		}
		const sameModel = (e: EntryLike) =>
			e.message?.provider === lastRequest!.provider && e.message?.model === lastRequest!.model;

		// Walk only the subtree below the last request: every path there
		// resends the full prefix up to it. `passedRequest` marks paths where a
		// same-model request already moved Anthropic's read point deeper.
		const stack: { entry: EntryLike; passedRequest: boolean }[] =
			(children.get(lastRequest.id) ?? []).map((entry) => ({ entry, passedRequest: false }));
		while (stack.length) {
			const { entry: e, passedRequest } = stack.pop()!;
			if (breaksPrefix(e, sharedIds)) continue;
			const off = !(e.id && onBranch.has(e.id));
			const counts = mode === "automatic" || !passedRequest;
			let next = passedRequest;
			if (e.type === "usage" && e.kind === "cache_warm") {
				// Replays the newest request above it on this path.
				if (off && counts) warm.push({ at: entryTime(e), provider: e.provider });
			} else if (isRequest(e) && sameModel(e)) {
				if (off && counts) {
					const at = requestTime(e);
					if (relatedRequestAt === undefined || at > relatedRequestAt) relatedRequestAt = at;
				}
				next = true;
			}
			if (mode === "breakpoint" && next) {
				// Nothing deeper can refresh our entry; a warm below would replay
				// this deeper request, and later requests read newer breakpoints.
				continue;
			}
			for (const child of children.get(e.id ?? "") ?? []) stack.push({ entry: child, passedRequest: next });
		}
	}

	const nsStart = options.namespaceStartAt;
	if (nsStart !== undefined && relatedRequestAt !== undefined && relatedRequestAt < nsStart) relatedRequestAt = undefined;
	const warmAts = warm
		.filter((w) => !lastRequest?.provider || !w.provider || w.provider === lastRequest.provider)
		.filter((w) => !lastRequest || w.at >= lastRequest.at)
		.filter((w) => nsStart === undefined || w.at >= nsStart)
		.map((w) => w.at)
		.sort((a, b) => a - b);
	const inheritedFrom = nsStart !== undefined && lastRequest && lastRequest.at < nsStart ? nsStart : undefined;
	return { lastRequest, warmAts, relatedRequestAt, remindedForTouchAt, contextReset, inheritedFrom };
}

// ---------------------------------------------------------------------------
// Expiry evaluation
// ---------------------------------------------------------------------------

export interface WarmingDecisionObservation {
	at: number;
	action: "warm" | "stop";
	expectedSavings: number;
}

export interface EvaluateInput {
	scan: BranchScan;
	model: ModelLike;
	ttl: TtlResolution;
	warming: WarmingEligibility;
	lastDecision?: WarmingDecisionObservation;
	graceMs?: number;
}

export interface Evaluation {
	lastRequestAt: number;
	lastTouchAt: number;
	expiresAt: number;
	/** When to (re)check; includes grace for an in-flight pi warm. */
	checkAt: number;
	warmCount: number;
	lastWarmAt?: number;
	warmingSummary: string;
	/** Prompt size of the last request, as counted by that model's tokenizer. */
	promptTokens?: number;
	/** Session-keyed fork that has not sent anything under its own key yet. */
	coldFork?: boolean;
}

export function formatClock(ms: number): string {
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return s % 60 === 0 ? `${s / 60}m` : `${Math.floor(s / 60)}m${s % 60}s`;
	if (s < 86_400) return s % 3600 === 0 ? `${s / 3600}h` : `${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60)}m`;
	return `${Math.round(s / 86_400)}d`;
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}k`;
	return String(n);
}

/** Plain-English reason for Pi warming being unavailable. */
function warmingUnavailableReason(reason: string | undefined): string {
	if (!reason) return "not available";
	if (reason === "cacheWarming=off") return "off in settings";
	if (reason.startsWith("model has no promptCache")) return "not available for this model";
	if (reason.includes("not replayable")) return "not available with budget thinking";
	if (reason.includes("too short")) return "not available (cache lifetime too short)";
	return reason;
}

/** One short phrase describing what Pi cache warming did for this cache. */
function summarizeWarming(
	w: WarmingEligibility,
	warmCount: number,
	lastWarmAt: number | undefined,
	lastRequestAt: number,
	lastDecision: WarmingDecisionObservation | undefined,
): string {
	const refreshed = warmCount > 0 && lastWarmAt !== undefined
		? `refreshed ${warmCount}×, last ${formatClock(lastWarmAt)}`
		: undefined;
	if (!w.eligible) {
		const why = warmingUnavailableReason(w.reason);
		return refreshed ? `${refreshed}, then stopped (${why})` : capitalize(why);
	}
	if (!w.idle) {
		return refreshed
			? `${capitalize(refreshed)}; stops when agent finishes (streaming mode)`
			: "Stops when agent finishes (streaming mode)";
	}
	let why = "";
	if (lastDecision && lastDecision.action === "stop" && lastDecision.at >= lastRequestAt) {
		why = "not worth the cost";
	} else if (lastWarmAt !== undefined && w.ttlMs && lastWarmAt + w.ttlMs >= lastRequestAt + PI_IDLE_WARMING_MAX_AGE_MS) {
		why = "30-min idle limit";
	}
	if (refreshed) return `${capitalize(refreshed)}, then stopped${why ? ` (${why})` : ""}`;
	return why ? `Skipped (${why})` : "Did not refresh";
}

function capitalize(text: string): string {
	return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/**
 * Warming text is stored in each entry. Rewrite wording saved by earlier
 * versions so old reminders read the same as new ones.
 */
export function displayWarming(stored: string): string {
	const inactive = /^pi warming inactive \((.*)\)$/.exec(stored);
	if (inactive) return capitalize(warmingUnavailableReason(inactive[1]));
	if (stored.startsWith("pi idle warming did not refresh")) return "Did not refresh";
	if (stored.startsWith("pi warming in streaming mode")) return "Stops when agent finishes (streaming mode)";
	return capitalize(stored.replace(/^pi (idle )?warming /, ""));
}

export function evaluate(input: EvaluateInput): Evaluation | undefined {
	const { scan, model, ttl, warming } = input;
	if (!scan.lastRequest || scan.contextReset || scan.inheritedFrom !== undefined) return undefined;
	const lastRequestAt = scan.lastRequest.at;
	const lastWarmAt = scan.warmAts.length ? scan.warmAts[scan.warmAts.length - 1] : undefined;
	const lastTouchAt = Math.max(lastRequestAt, lastWarmAt ?? 0, scan.relatedRequestAt ?? 0);
	const expiresAt = lastTouchAt + ttl.ttlMs;

	// A decision of `stop` means Pi's economics gate declined warming. Do not
	// wait for an in-flight refresh that Pi will not send.
	let checkAt = expiresAt;
	const warmingCouldStillRefresh = warming.eligible &&
		(!input.lastDecision || input.lastDecision.at < lastRequestAt || input.lastDecision.action === "warm");
	if (warmingCouldStillRefresh && warming.idle && lastTouchAt < lastRequestAt + PI_IDLE_WARMING_MAX_AGE_MS) {
		checkAt += input.graceMs ?? DEFAULT_WARM_GRACE_MS;
	}

	const u = scan.lastRequest.usage;
	const promptTokens = u ? u.input + u.cacheRead + u.cacheWrite : undefined;
	return {
		lastRequestAt,
		lastTouchAt,
		expiresAt,
		checkAt,
		warmCount: scan.warmAts.length,
		lastWarmAt,
		warmingSummary: summarizeWarming(warming, scan.warmAts.length, lastWarmAt, lastRequestAt, input.lastDecision),
		promptTokens,
	};
}

// ---------------------------------------------------------------------------
// Reminder payload
// ---------------------------------------------------------------------------

export interface ReminderData {
	version: 1;
	model: string;
	lastTouchAt: number;
	expiredAt: number;
	ttlMs: number;
	ttlSource: string;
	warming: string;
	promptTokens?: number;
}

export function buildReminder(model: ModelLike, ttl: TtlResolution, ev: Evaluation): ReminderData {
	return {
		version: 1,
		model: `${model.provider}/${model.id}`,
		lastTouchAt: ev.lastTouchAt,
		expiredAt: ev.expiresAt,
		ttlMs: ttl.ttlMs,
		ttlSource: ttl.source,
		warming: ev.warmingSummary,
		promptTokens: ev.promptTokens,
	};
}

/** Short human label for where the TTL came from. */
export function ttlLabel(source: string): string {
	if (source.startsWith("heuristic:")) return "estimated";
	if (source.startsWith("model promptCache")) return "from model";
	if (source.startsWith("config override")) return "configured";
	if (source.includes("1h cache write")) return "1h cache seen";
	if (source.includes("PI_CACHE_RETENTION")) return "long retention";
	return "from request";
}

function splitModel(model: string): { id: string; provider?: string } {
	const slash = model.indexOf("/");
	return slash < 0 ? { id: model } : { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

export interface ReminderView {
	/** Headline: what happened and what to do. */
	title: string;
	/** Details shown when expanded, as aligned label/value rows. */
	rows: [label: string, value: string][];
}

export function reminderView(data: ReminderData): ReminderView {
	const { id, provider } = splitModel(data.model);
	// No cost estimate: the cache is already gone, so the re-cache cost is
	// unavoidable, and it would be stale after a model switch (different
	// pricing and tokenizer). Context size still informs /compact or /new.
	const rows: [string, string][] = [
		["Model", provider ? `${id} (${provider})` : id],
		["Cache", `${formatClock(data.lastTouchAt)} → ~${formatClock(data.expiredAt)} · ${formatDuration(data.ttlMs)} TTL (${ttlLabel(data.ttlSource)})`],
	];
	if (data.promptTokens) rows.push(["Context", `${formatTokens(data.promptTokens)} tokens`]);
	rows.push(["Warming", displayWarming(data.warming)]);
	return {
		title: "Prompt cache may have expired. Now is a cheaper time to /compact, switch model, or change tool/skill loadout.",
		rows,
	};
}
