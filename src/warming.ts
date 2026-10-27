import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Raises pi's idle cache-warming continuation probability when there are signals
 * that the user is about to reply. Pi's built-in estimate is a flat 15%.
 * The extension can only turn a "stop" into "warm". It never stops warming that pi chose.
 *
 * "Is the agent waiting on the user?" is answered by TypeSafe's Jev classifier,
 * classified once when the agent settles so the refresh decision never waits on it.
 * Falls back to a "?" heuristic when Jev is unavailable.
 */

/** Same bar pi uses (CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS). */
const MIN_EXPECTED_SAVINGS = 0.05;
/** User has text in the editor or a queued message: reply is near-certain. */
const P_DRAFTING = 0.9;
/** Agent's final message waits on the user (question, decision, offered next step). */
const P_AWAITING_REPLY = 0.5;
/** Jev probability at or above which the final message counts as awaiting a reply. */
const JEV_AWAITING_THRESHOLD = 0.5;
/** Pi drops a refresh ~15s after its planned time for a 5-minute TTL; stay well inside that. */
const JEV_TIMEOUT_MS = 3_000;
/** Jev's context window is 32-64k tokens; the tail carries the ask. */
const MAX_MESSAGE_CHARS = 8_000;

const AWAITING_QUESTION = {
	awaiting: {
		type: "bool" as const,
		instructions:
			"`message` is the final message an AI coding assistant sent before going idle. Is the assistant waiting on the user: asking a question, requesting a decision or confirmation, or offering a next step for the user to accept?",
		criteria: {
			true: "Waiting on the user's reply or decision",
			false: "Finished or informational; no reply requested",
		},
	},
};

interface FinalMessage {
	entryId: string;
	text: string;
}

function lastAssistantMessage(ctx: ExtensionContext): FinalMessage | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as any;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") return undefined;
		if (message.role !== "assistant") continue;
		if (message.stopReason && message.stopReason !== "stop") return undefined;
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter((block: any) => block?.type === "text" && typeof block.text === "string")
							.map((block: any) => block.text)
							.join("\n")
					: "";
		return text.trim() ? { entryId: entry.id, text } : undefined;
	}
	return undefined;
}

/** Fallback: the final paragraph contains a sentence ending in "?". */
function endsWithQuestion(text: string): boolean {
	const withoutCode = text.replace(/```[\s\S]*?```/g, "").trim();
	const last = withoutCode.split(/\n\s*\n/).filter((p) => p.trim()).at(-1);
	return last ? /\?[\s*_`)\]"']*(?:$|\s)/m.test(last) : false;
}

/**
 * Classifier API from newer pi builds. Not in every published pi version, so
 * detect it at runtime and fall back to the heuristic when it's missing.
 */
interface ClassifierRegistry {
	findOfType(type: "classifier", provider: string, id: string): unknown;
	classify(
		model: unknown,
		input: { state: Record<string, string>; questions: typeof AWAITING_QUESTION },
		options: { signal: AbortSignal },
	): Promise<{ stopReason: string; answers: Record<string, { type: string; probability?: number } | undefined> }>;
}

function classifierRegistry(ctx: ExtensionContext): ClassifierRegistry | undefined {
	const registry = ctx.modelRegistry as unknown as Partial<ClassifierRegistry>;
	return typeof registry.findOfType === "function" && typeof registry.classify === "function"
		? (registry as ClassifierRegistry)
		: undefined;
}

/** Jev's P(awaiting reply), or undefined when Jev is unavailable or fails. */
async function classifyAwaiting(ctx: ExtensionContext, text: string): Promise<number | undefined> {
	const registry = classifierRegistry(ctx);
	if (!registry) return undefined;
	try {
		const jev =
			registry.findOfType("classifier", "ramp-router", "jev-latest") ??
			registry.findOfType("classifier", "typesafe", "jev-latest");
		if (!jev) return undefined;
		const result = await registry.classify(
			jev,
			{ state: { message: text.slice(-MAX_MESSAGE_CHARS) }, questions: AWAITING_QUESTION },
			{ signal: AbortSignal.timeout(JEV_TIMEOUT_MS) },
		);
		const answer = result.stopReason === "stop" ? result.answers.awaiting : undefined;
		return answer?.type === "bool" ? answer.probability : undefined;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	/** Jev verdict for the latest final message, started when the agent settles. */
	let pending: { entryId: string; probability: Promise<number | undefined> } | undefined;

	const classifyLatest = (ctx: ExtensionContext) => {
		const final = lastAssistantMessage(ctx);
		if (!final) return undefined;
		if (pending?.entryId !== final.entryId) {
			pending = { entryId: final.entryId, probability: classifyAwaiting(ctx, final.text) };
		}
		return { final, probability: pending.probability };
	};

	pi.on("agent_settled", (_event, ctx) => {
		classifyLatest(ctx);
	});

	pi.on("cache_warming_decision", async (event, ctx) => {
		// Only adjust idle decisions that pi would stop. Streaming warming already uses p = 1.
		if (event.action !== "stop" || event.continuationProbability >= 1) return;

		let p: number | undefined;
		if (ctx.hasPendingMessages() || (ctx.hasUI && ctx.ui.getEditorText().trim())) {
			p = P_DRAFTING;
		} else {
			const latest = classifyLatest(ctx);
			if (latest) {
				const jevProbability = await latest.probability;
				const awaiting =
					jevProbability === undefined ? endsWithQuestion(latest.final.text) : jevProbability >= JEV_AWAITING_THRESHOLD;
				if (awaiting) p = P_AWAITING_REPLY;
			}
		}

		if (p === undefined || p <= event.continuationProbability) return;
		if (p * event.missCost - event.warmCost < MIN_EXPECTED_SAVINGS) return;
		return { action: "warm" };
	});
}
