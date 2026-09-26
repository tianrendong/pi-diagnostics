/**
 * Mirror of Pi's native cache-miss notice (`showCacheMissNotices`).
 *
 * Pi renders its notice straight into the interactive transcript: it is not a session entry and
 * extensions cannot extend it. To complement rather than duplicate it, this module predicts when
 * Pi shows that notice so provider diagnostics can render as a follow-up line underneath it.
 *
 * Ported from Pi's `core/cache-stats.ts` and `InteractiveMode.addCacheMissNotice` (0.87).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Per-turn misses at or below this are cache breakpoint granularity noise. */
const NOISE_FLOOR_TOKENS = 1024;
/** Pi hides misses below both of these. */
const NOTICE_MIN_TOKENS = 20_000;
const NOTICE_MIN_COST = 0.1;

interface UsageLike {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { input?: number; cacheRead?: number; cacheWrite?: number };
}

export interface AssistantLike {
  role: string;
  provider?: string;
  model?: string;
  timestamp?: number;
  usage?: UsageLike;
}

interface EntryLike {
  type: string;
  kind?: string;
  provider?: string;
  model?: string;
  timestamp?: string;
  usage?: UsageLike;
  message?: AssistantLike;
}

interface PreviousRequest {
  promptTokens: number;
  modelKey: string;
  timestamp: number;
  reportedCache: boolean;
}

export interface NativeMiss {
  missedTokens: number;
  missedCost: number;
  idleMs: number;
  modelChanged: boolean;
}

/** Cache-read price per million tokens, used when the missed turn read nothing from cache. */
export type CacheReadPrice = (provider: string, model: string) => number | undefined;

function promptTokens(usage: UsageLike): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

function isUsage(value: unknown): value is UsageLike {
  if (typeof value !== "object" || value === null) return false;
  const usage = value as Record<string, unknown>;
  return typeof usage.input === "number" && typeof usage.cacheRead === "number" && typeof usage.cacheWrite === "number";
}

function previousRequest(entries: readonly EntryLike[]): PreviousRequest | undefined {
  let prev: PreviousRequest | undefined;
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      prev = undefined;
    } else if (entry.type === "usage" && entry.kind === "cache_warm" && isUsage(entry.usage)) {
      const tokens = promptTokens(entry.usage);
      if (tokens > 0) {
        prev = {
          promptTokens: tokens,
          modelKey: `${entry.provider}/${entry.model}`,
          timestamp: Date.parse(entry.timestamp ?? ""),
          reportedCache: true,
        };
      }
    } else if (entry.type === "message" && entry.message?.role === "assistant" && isUsage(entry.message.usage)) {
      const usage = entry.message.usage;
      const tokens = promptTokens(usage);
      if (tokens > 0) {
        prev = {
          promptTokens: tokens,
          modelKey: `${entry.message.provider}/${entry.message.model}`,
          timestamp: entry.message.timestamp ?? 0,
          reportedCache: (prev?.reportedCache ?? false) || usage.cacheRead + usage.cacheWrite > 0,
        };
      }
    }
  }
  return prev;
}

/**
 * Pi's miss detection for `message`. `entriesBefore` are all session entries (file order, every
 * branch, like Pi) that precede the message.
 */
export function detectNativeMiss(
  entriesBefore: readonly EntryLike[],
  message: AssistantLike,
  cacheReadPrice?: CacheReadPrice,
): NativeMiss | undefined {
  const usage = message.usage;
  if (!isUsage(usage)) return undefined;
  const prev = previousRequest(entriesBefore);
  const tokens = promptTokens(usage);
  if (!prev || tokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)) return undefined;
  const missedTokens = Math.min(prev.promptTokens, tokens) - usage.cacheRead;
  if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

  const cost = usage.cost ?? {};
  const paidTokens = usage.input + usage.cacheWrite;
  const paidPerToken = paidTokens > 0 ? ((cost.input ?? 0) + (cost.cacheWrite ?? 0)) / paidTokens : 0;
  const readPerToken = usage.cacheRead > 0
    ? (cost.cacheRead ?? 0) / usage.cacheRead
    : (cacheReadPrice?.(message.provider ?? "", message.model ?? "") ?? 0) / 1_000_000;
  return {
    missedTokens,
    missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
    idleMs: Math.max(0, (message.timestamp ?? 0) - prev.timestamp),
    modelChanged: `${message.provider}/${message.model}` !== prev.modelKey,
  };
}

/** Whether Pi renders a notice for this miss (when `showCacheMissNotices` is on). */
export function isNativeNoticeShown(miss: NativeMiss | undefined): boolean {
  return miss !== undefined && (miss.missedTokens >= NOTICE_MIN_TOKENS || miss.missedCost >= NOTICE_MIN_COST);
}

interface SettingsScope {
  cwd?: string;
  projectTrusted?: boolean;
}

function readSetting(path: string): boolean | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    if (typeof value !== "object" || value === null) return undefined;
    const show = (value as Record<string, unknown>).showCacheMissNotices;
    return typeof show === "boolean" ? show : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads Pi's `showCacheMissNotices` (project overrides global, default off). Extensions cannot
 * reach Pi's SettingsManager, so this reads the files, cached briefly because renderers call it
 * on every frame.
 */
export function createNativeNoticeSetting(ttlMs = 1_000) {
  let scope: SettingsScope = {};
  let cached: { value: boolean; at: number; key: string } | undefined;
  return {
    setScope(next: SettingsScope): void {
      scope = next;
      cached = undefined;
    },
    enabled(now = Date.now()): boolean {
      const agentDir = getAgentDir();
      const key = `${agentDir}\0${scope.cwd ?? ""}\0${scope.projectTrusted ?? false}`;
      if (cached && cached.key === key && now - cached.at < ttlMs) return cached.value;
      const project = scope.cwd && scope.projectTrusted
        ? readSetting(join(scope.cwd, CONFIG_DIR_NAME, "settings.json"))
        : undefined;
      const value = project ?? readSetting(join(agentDir, "settings.json")) ?? false;
      cached = { value, at: now, key };
      return value;
    },
  };
}
