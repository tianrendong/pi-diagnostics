import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, keyText, type ExtensionAPI, type ExtensionContext, type ModelSelectEvent, type ThinkingLevelSelectEvent } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import {
	DEFAULT_WARM_GRACE_MS,
	REMINDER_TYPE,
	cacheKeyScope,
	type CacheWarmingMode,
	type EntryLike,
	type ModelLike,
	type ReminderData,
	type WarmingDecisionObservation,
	buildReminder,
	evaluate,
	inspectPayload,
	normalizeWarmingMode,
	predictPiWarming,
	prefixCacheMode,
	reminderView,
	resolveTtl,
	scanBranch,
} from "./expiry-core.ts";

interface SettingsFile {
	cacheWarming?: unknown;
}

/** Set PI_EXPIRY_REMINDER_DEBUG=/path/to/log to trace scheduling decisions. */
function debug(message: string): void {
	const file = process.env.PI_EXPIRY_REMINDER_DEBUG;
	if (!file) return;
	try {
		appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// Debug logging must never affect the session.
	}
}

/** Display text for Pi's "toggle tool output" key (ctrl+o unless remapped). */
function expandKeyText(): string {
	try {
		return keyText("app.tools.expand") || "ctrl+o";
	} catch {
		return "ctrl+o";
	}
}

function modelKey(model: ModelLike | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

function asModel(value: ExtensionContext["model"]): ModelLike | undefined {
	if (!value) return undefined;
	return value as ModelLike;
}

async function readSettings(): Promise<SettingsFile> {
	try {
		const text = await readFile(join(getAgentDir(), "settings.json"), "utf8");
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null ? value as SettingsFile : {};
	} catch {
		return {};
	}
}

function entryLikeBranch(ctx: ExtensionContext): EntryLike[] {
	return ctx.sessionManager.getBranch() as unknown as EntryLike[];
}

function entryLikeAll(ctx: ExtensionContext): EntryLike[] {
	return ctx.sessionManager.getEntries() as unknown as EntryLike[];
}

/**
 * Show one durable transcript entry after expiry. `appendEntry`, unlike
 * `sendMessage`, is never projected into provider context.
 */
export default function cacheExpiryReminder(pi: ExtensionAPI): void {
	let settings: SettingsFile = {};
	let warmingMode: CacheWarmingMode = "streaming";
	let envRetention = process.env.PI_CACHE_RETENTION;
	// Pi builds a fresh ExtensionContext object for every event, so never
	// compare contexts by identity. Track the active session by id instead and
	// keep the most recent context for timer callbacks.
	let latestContext: ExtensionContext | undefined;
	let activeSessionId: string | undefined;
	let sessionNamespaceStartAt: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let payloadHints = new Map<string, ReturnType<typeof inspectPayload>>();
	let lastDecision: WarmingDecisionObservation | undefined;
	let generation = 0;

	pi.registerEntryRenderer<ReminderData>(REMINDER_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const view = reminderView(data);
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		// Pi's app.tools.expand (ctrl+o) toggles `expanded` on every custom entry,
		// same as tool output. Hint the toggle in both states.
		const hint = `  ${theme.fg("dim", expandKeyText())}${theme.fg("muted", expanded ? " collapse" : " details")}`;
		box.addChild(new Text(`${theme.fg("warning", `⏱ ${view.title}`)}${hint}`, 0, 0));
		if (expanded) {
			const width = Math.max(...view.rows.map(([label]) => label.length));
			box.addChild(new Spacer(1));
			for (const [label, value] of view.rows) {
				box.addChild(new Text(`${theme.fg("dim", label.padEnd(width))}  ${theme.fg("customMessageText", value)}`, 2, 0));
			}
		}
		return box;
	});

	const clearTimer = (): void => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};

	const track = (ctx: ExtensionContext): boolean => {
		const id = ctx.sessionManager.getSessionId();
		if (activeSessionId !== undefined && id !== activeSessionId) return false;
		latestContext = ctx;
		return true;
	};

	const schedule = (delayMs: number): void => {
		clearTimer();
		const token = generation;
		timer = setTimeout(() => {
			timer = undefined;
			if (token !== generation || !latestContext) return;
			void check(latestContext).catch((error: unknown) => {
				// Stale context after reload/session replacement; next session_start re-arms.
				debug(`error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
			});
		}, Math.max(100, delayMs));
		timer.unref?.();
	};

	const check = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.sessionManager.getSessionId() !== activeSessionId) return debug("skip: inactive session");
		settings = await readSettings();
		warmingMode = normalizeWarmingMode(settings.cacheWarming);
		const model = asModel(ctx.model);
		if (!model) return debug("skip: no model");
		const hints = payloadHints.get(modelKey(model)!) ?? {};
		const namespaceStartAt = cacheKeyScope(model, hints) === "session" ? sessionNamespaceStartAt : undefined;
		const scan = scanBranch(entryLikeBranch(ctx), {
			allEntries: entryLikeAll(ctx),
			mode: prefixCacheMode(model, hints),
			namespaceStartAt,
		});
		if (!scan.lastRequest) return debug("skip: no request on branch");
		if (scan.inheritedFrom !== undefined) return debug("skip: fork copied request into new cache namespace");
		if (scan.contextReset) return debug("skip: context reset after last request");

		// Do not report an old provider cache after model switching. New request
		// will establish a new cache baseline, then this loop starts again.
		if (modelKey(model) !== `${scan.lastRequest.provider}/${scan.lastRequest.model}`) {
			return debug(`skip: model ${modelKey(model)} != last request ${scan.lastRequest.provider}/${scan.lastRequest.model}`);
		}

		const ttl = resolveTtl({
			model,
			hints,
			lastUsage: scan.lastRequest.usage,
			envRetention,
		});
		if (!ttl) return debug("skip: prompt caching disabled or unknown");

		const warming = predictPiWarming(warmingMode, model, ctx.thinkingLevel, envRetention);
		const result = evaluate({
			scan,
			model,
			ttl,
			warming,
			lastDecision,
			graceMs: DEFAULT_WARM_GRACE_MS,
		});
		if (!result) return debug("skip: no evaluation");

		const now = Date.now();
		if (now < result.expiresAt) {
			debug(`wait: expires ${new Date(result.expiresAt).toISOString()} ttl=${ttl.ttlMs} (${ttl.source}); ${result.warmingSummary}`);
			schedule(result.checkAt - now);
			return;
		}
		if (scan.remindedForTouchAt === result.lastTouchAt) return debug("skip: already reminded");
		if (!ctx.isIdle() || ctx.hasPendingMessages()) {
			debug("defer: agent busy");
			schedule(5_000);
			return;
		}
		debug(`remind: expired ${new Date(result.expiresAt).toISOString()}`);

		pi.appendEntry<ReminderData>(REMINDER_TYPE, buildReminder(model, ttl, result));
	};

	const reset = (): void => {
		generation++;
		clearTimer();
	};

	pi.on("session_start", async (event, ctx) => {
		activeSessionId = ctx.sessionManager.getSessionId();
		latestContext = ctx;
		const header = ctx.sessionManager.getHeader?.();
		sessionNamespaceStartAt = event.reason === "fork"
			? (Date.parse(header?.timestamp ?? "") || Date.now())
			: undefined;
		settings = await readSettings();
		warmingMode = normalizeWarmingMode(settings.cacheWarming);
		envRetention = process.env.PI_CACHE_RETENTION;
		reset();
		// Existing sessions get checked immediately; fresh sessions have no request.
		schedule(0);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = asModel(ctx.model);
		if (model) payloadHints.set(modelKey(model)!, inspectPayload(event.payload));
		return undefined;
	});

	pi.on("cache_warming_decision", (event) => {
		lastDecision = {
			at: Date.now(),
			action: event.action,
			expectedSavings: event.continuationProbability * event.missCost - event.warmCost,
		};
		return undefined;
	});

	pi.on("agent_start", (_event, ctx) => {
		if (track(ctx)) reset();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!track(ctx)) return;
		// Global setting can change mid-session via /settings.
		settings = await readSettings();
		warmingMode = normalizeWarmingMode(settings.cacheWarming);
		schedule(0);
	});

	pi.on("model_select", (event: ModelSelectEvent, ctx) => {
		if (track(ctx)) reset();
		payloadHints.delete(modelKey(asModel(event.previousModel))!);
	});

	pi.on("thinking_level_select", (_event: ThinkingLevelSelectEvent, ctx) => {
		if (track(ctx)) reset();
	});
	pi.on("session_tree", (_event, ctx) => {
		// New leaf may resend a different prefix; re-evaluate from the new branch.
		if (!track(ctx)) return;
		reset();
		schedule(0);
	});
	pi.on("session_shutdown", () => {
		reset();
		latestContext = undefined;
		activeSessionId = undefined;
		sessionNamespaceStartAt = undefined;
	});
}
