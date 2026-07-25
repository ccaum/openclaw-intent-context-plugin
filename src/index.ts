import { Type, type Static } from "typebox";
import { definePluginEntry, buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Default values — all overridable via configSchema.
const DEFAULT_OPENCLAW_BIN = "/opt/homebrew/bin/openclaw";
const DEFAULT_INTENTS_DIR = "~/.openclaw/intents";
const DEFAULT_NOTIFY_INTERVAL_MS = 60_000;
const DEFAULT_ACTIVITY_WINDOW_MS = 6 * 60 * 60 * 1000;
const DEFAULT_LOG_RETENTION_MS = 48 * 60 * 60 * 1000;
const DEFAULT_FALLBACK_NOTIFY_CHANNEL = "bluebubbles";
const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes
const LOCK_RETRY_COUNT = 5;
const LOCK_RETRY_DELAY_MS = 1000;

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

const AgentAwarenessConfigSchema = Type.Object(
  {
    watchedTriggerTypes: Type.Optional(Type.Array(Type.String())),
    actorFor: Type.Optional(Type.Array(Type.String())),
    ambientScope: Type.Optional(Type.Union([Type.Literal("all"), Type.Array(Type.String())])),
  },
  { additionalProperties: false },
);

export const ConfigSchema = Type.Object(
  {
    intentsDir: Type.Optional(Type.String({ description: "Path to the shared intents store. Defaults to ~/.openclaw/intents." })),
    agents: Type.Record(Type.String(), AgentAwarenessConfigSchema, {
      description: "Per-agent awareness config, keyed by agentId.",
    }),
    notifyExecutorIntervalMs: Type.Optional(Type.Number({ description: "Poll interval for the mechanical notify executor. Default 60000." })),
    recentActivityWindowMs: Type.Optional(Type.Number({ description: "How far back to surface ambient-activity entries. Default 6h." })),
    openclawBin: Type.Optional(Type.String({ description: "Path to the openclaw CLI binary. Default /opt/homebrew/bin/openclaw." })),
    fallbackNotifyChannel: Type.Optional(Type.String({ description: "Channel used when an intent's action.channel is unset. Default bluebubbles." })),
    logRetentionMs: Type.Optional(Type.Number({ description: "Retention window for pruning recent-activity.jsonl. Default 48h." })),
  },
  { additionalProperties: false },
);
export type PluginConfig = Static<typeof ConfigSchema>;
export type AgentAwarenessConfig = Static<typeof AgentAwarenessConfigSchema>;

export interface IntentPaths {
  intentsDir: string;
  pendingPath: string;
  archivePath: string;
  activityLogPath: string;
  lockDir: string;
}

export function resolvePaths(config: Pick<PluginConfig, "intentsDir">): IntentPaths {
  const intentsDir = path.resolve(expandHome(config.intentsDir ?? DEFAULT_INTENTS_DIR));
  return {
    intentsDir,
    pendingPath: path.join(intentsDir, "pending.json"),
    archivePath: path.join(intentsDir, "archive.json"),
    activityLogPath: path.join(intentsDir, "recent-activity.jsonl"),
    lockDir: path.join(intentsDir, ".lock"),
  };
}

async function readJsonArray(filePath: string): Promise<Record<string, any>[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function readJsonLines(filePath: string): Promise<Record<string, any>[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, any> => entry !== null);
  } catch {
    return [];
  }
}

function withinWindow(timestamp: unknown, windowMs: number, now: number): boolean {
  if (typeof timestamp !== "string") return false;
  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts)) return false;
  return now - ts <= windowMs;
}

export async function buildInjectionForAgent(
  agentConfig: AgentAwarenessConfig,
  paths: IntentPaths,
  windows: { recentActivityWindowMs: number },
  now: number = Date.now(),
): Promise<string | null> {
  const sections: string[] = [];

  if (agentConfig.watchedTriggerTypes && agentConfig.watchedTriggerTypes.length > 0) {
    const pending = await readJsonArray(paths.pendingPath);
    const watching = pending.filter(
      (item) => item.status === "pending" && agentConfig.watchedTriggerTypes!.includes(item.trigger?.type),
    );
    if (watching.length > 0) {
      sections.push(
        [
          "WATCHING FOR (pending intents in your domain — recognize a match, don't wait to be told):",
          ...watching.map(
            (item) => `- [${item.id}] ${item.description} — conditions: ${JSON.stringify(item.trigger?.conditions ?? {})}`,
          ),
        ].join("\n"),
      );
    }
  }

  if (agentConfig.actorFor && agentConfig.actorFor.length > 0) {
    const pending = await readJsonArray(paths.pendingPath);
    const acting = pending.filter(
      (item) => item.status === "triggered" && agentConfig.actorFor!.includes(item.notify_agent),
    );
    if (acting.length > 0) {
      sections.push(
        [
          "ACTION NEEDED (triggered intents assigned to you):",
          ...acting.map(
            (item) =>
              `- [${item.id}] ${item.description} — action: ${JSON.stringify(item.action ?? {})} — data: ${JSON.stringify(item.trigger_data ?? {})}`,
          ),
        ].join("\n"),
      );
    }
  }

  if (agentConfig.ambientScope) {
    const activity = await readJsonLines(paths.activityLogPath);
    const recent = activity.filter((entry) => {
      if (!withinWindow(entry.timestamp, windows.recentActivityWindowMs, now)) return false;
      if (agentConfig.ambientScope === "all") return true;
      return Array.isArray(agentConfig.ambientScope) && agentConfig.ambientScope.includes(entry.agent);
    });
    if (recent.length > 0) {
      sections.push(
        [
          "RECENT ACTIVITY from other agents (background context, not urgent):",
          ...recent.map((entry) => `- [${entry.agent}, ${entry.timestamp}] ${entry.text}`),
        ].join("\n"),
      );
    }
  }

  if (sections.length === 0) return null;
  const body = sections.join("\n\n");
  return [
    "--- intent-context plugin: auto-generated context (not part of user request) ---",
    body,
    "--- end intent-context plugin ---",
  ].join("\n\n");
}

function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = data?.[key];
    return value === undefined || value === null ? "N/A" : String(value);
  });
}

// Writes a metadata file inside the lock directory so we can detect stale locks.
// The file records the holding PID and a timestamp. If the lock is older than
// LOCK_STALE_MS we reclaim it by removing and recreating the directory.
async function writeLockMeta(lockDir: string): Promise<void> {
  const meta = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(lockDir, "lock.meta"), JSON.stringify(meta), "utf8");
}

async function readLockMeta(lockDir: string): Promise<{ pid: number; startedAt: string } | null> {
  try {
    const raw = await fs.readFile(path.join(lockDir, "lock.meta"), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "string") {
      return { pid: parsed.pid, startedAt: parsed.startedAt };
    }
    return null;
  } catch {
    return null;
  }
}

async function isLockStale(lockDir: string, staleMs: number, now: number = Date.now()): Promise<boolean> {
  const meta = await readLockMeta(lockDir);
  if (!meta) return true; // No meta file → treat as stale (orphaned or corrupted)
  const ts = Date.parse(meta.startedAt);
  if (Number.isNaN(ts)) return true; // Unparseable timestamp → stale
  return now - ts > staleMs;
}

async function reclaimLock(lockDir: string): Promise<void> {
  // Remove the stale lock directory and its contents, then recreate.
  await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(lockDir);
}

export async function withIntentsLock<T>(
  lockDir: string,
  fn: () => Promise<T>,
  opts?: { staleMs?: number; onLockFailure?: (error: string) => void | Promise<void> },
): Promise<T> {
  const staleMs = opts?.staleMs ?? LOCK_STALE_MS;
  let acquired = false;
  let lastError = "";
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      await fs.mkdir(lockDir);
      acquired = true;
      break;
    } catch {
      // Lock exists — check if it's stale and reclaim.
      const stale = await isLockStale(lockDir, staleMs);
      if (stale) {
        try {
          await reclaimLock(lockDir);
          await writeLockMeta(lockDir);
          acquired = true;
          break;
        } catch (reclaimError) {
          lastError = `Failed to reclaim stale lock at ${lockDir}: ${reclaimError instanceof Error ? reclaimError.message : String(reclaimError)}`;
        }
      } else {
        lastError = `Lock held at ${lockDir} (not stale yet)`;
      }
      if (attempt < LOCK_RETRY_COUNT - 1) {
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
      }
    }
  }
  if (!acquired) {
    const msg = `Could not acquire intents lock at ${lockDir} after ${LOCK_RETRY_COUNT} retries: ${lastError}`;
    if (opts?.onLockFailure) {
      try { await opts.onLockFailure(msg); } catch { /* don't let alert failure mask the original error */ }
    }
    throw new Error(msg);
  }
  // Write our lock metadata after acquiring (covers both fresh mkdir and reclaim paths).
  await writeLockMeta(lockDir);
  try {
    return await fn();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface NotifyExecutorResult {
  processed: number;
}

// Executes status="triggered" + action.type="notify" intents directly —
// pure mechanical message delivery, no agent judgment needed. Mirrors the
// retired execute-triggered-intents.sh script's behavior exactly (including
// updating status in place in whichever file the intent was found, not
// moving pending -> archive), just running as plugin code instead of an
// LLM-backed cron turn.
export async function runNotifyExecutor(
  paths: IntentPaths,
  opts?: { openclawBin?: string; fallbackNotifyChannel?: string },
): Promise<NotifyExecutorResult> {
  const openclawBin = opts?.openclawBin ?? DEFAULT_OPENCLAW_BIN;
  const fallbackChannel = opts?.fallbackNotifyChannel ?? DEFAULT_FALLBACK_NOTIFY_CHANNEL;
  return withIntentsLock(
    paths.lockDir,
    async () => {
      let processed = 0;
      for (const filePath of [paths.pendingPath, paths.archivePath]) {
        const items = await readJsonArray(filePath);
        if (items.length === 0) continue;
        let changed = false;
        for (const item of items) {
          if (item.status !== "triggered" || item.action?.type !== "notify") continue;
          const template = typeof item.action.message_template === "string" ? item.action.message_template : "";
          const rendered = renderTemplate(template, item.trigger_data ?? {});
          const message = rendered.trim().length > 0 ? rendered : item.description ?? "";
          const channel = item.action.channel ?? fallbackChannel;
          const args = ["message", "send", "--channel", channel, "-m", message];
          if (item.action.target) args.push("--target", String(item.action.target));
          try {
            await execFileAsync(openclawBin, args, { timeout: 30000 });
            item.completion_result = `Notification sent via ${channel} to ${item.action.target ?? "default"}`;
          } catch (error) {
            item.completion_result = `Failed to send notification: ${error instanceof Error ? error.message : String(error)}`;
          }
          item.status = "completed";
          item.completed_at = new Date().toISOString();
          changed = true;
          processed += 1;
        }
        if (changed) await fs.writeFile(filePath, JSON.stringify(items, null, 2), "utf8");
      }
      return { processed };
    },
    {
      onLockFailure: async (errorMsg: string) => {
        // Surface persistent lock-acquisition failure so it doesn't silently deadlock.
        try {
          await execFileAsync(
            openclawBin,
            ["message", "send", "--channel", fallbackChannel, "-m", `[intent-context] ${errorMsg}`],
            { timeout: 15000 },
          );
        } catch {
          // If we can't send the alert, there's nothing more to do — the error is still thrown.
        }
      },
    },
  );
}

async function pruneLogFile(filePath: string, retentionMs: number, now: number = Date.now()): Promise<void> {
  const entries = await readJsonLines(filePath);
  if (entries.length === 0) return;
  const kept = entries.filter((entry) => withinWindow(entry.timestamp, retentionMs, now));
  if (kept.length === entries.length) return;
  const body = kept.map((entry) => JSON.stringify(entry)).join("\n");
  await fs.writeFile(filePath, kept.length > 0 ? `${body}\n` : "", "utf8");
}

const pluginEntry: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "intent-context",
  name: "Intent Context",
  description:
    "Injects relevant intents, recent domain events, and ambient cross-agent activity into each configured agent's turn (before_prompt_build), and executes mechanical notify-type triggered intents directly. No active wake of any agent — everything surfaces on whatever turn happens next.",
  configSchema: buildJsonPluginConfigSchema(ConfigSchema as any),
  register(api) {
    const config = api.pluginConfig as PluginConfig;
    const paths = resolvePaths(config);
    const windows = {
      recentActivityWindowMs: config.recentActivityWindowMs ?? DEFAULT_ACTIVITY_WINDOW_MS,
    };

    api.on("before_prompt_build", async (_event, ctx) => {
      const agentId = ctx.agentId;
      if (!agentId) return;
      const agentConfig = config.agents?.[agentId];
      if (!agentConfig) return;
      const injection = await buildInjectionForAgent(agentConfig, paths, windows);
      if (!injection) return;
      return { prependContext: injection };
    });

    let intervalHandle: ReturnType<typeof setInterval> | undefined;
    api.on("gateway_start", async () => {
      await fs.mkdir(paths.intentsDir, { recursive: true });
      const intervalMs = config.notifyExecutorIntervalMs ?? DEFAULT_NOTIFY_INTERVAL_MS;
      const logRetentionMs = config.logRetentionMs ?? DEFAULT_LOG_RETENTION_MS;
      const executorOpts = {
        openclawBin: config.openclawBin ?? DEFAULT_OPENCLAW_BIN,
        fallbackNotifyChannel: config.fallbackNotifyChannel ?? DEFAULT_FALLBACK_NOTIFY_CHANNEL,
      };
      intervalHandle = setInterval(() => {
        runNotifyExecutor(paths, executorOpts).catch((error) => {
          console.error("[intent-context] notify executor error", error);
        });
        pruneLogFile(paths.activityLogPath, logRetentionMs).catch(() => {});
      }, intervalMs);
    });
    api.on("gateway_stop", async () => {
      if (intervalHandle) clearInterval(intervalHandle);
    });

    api.registerTool(
      (toolCtx) => ({
        name: "log_activity",
        label: "Log Activity",
        description:
          "Append a short note about what you're doing to the shared ambient-activity log, so other agents can see it as background context on their own next turn. This does not notify or wake anyone — it's picked up passively, whenever the interested agent's next turn happens.",
        parameters: Type.Object({
          text: Type.String({
            minLength: 1,
            description: "Short description of what happened, e.g. \"Picked up ticket HA-F006: Intelligent clip content selection.\"",
          }),
          agent: Type.Optional(Type.String({
            description: "Agent or system identifier. Defaults to the calling session's agentId. External systems calling via /tools/invoke should set this to identify themselves (e.g. \"marlin\").",
          })),
        }),
        execute: async (_toolCallId: string, params: { text: string; agent?: string }) => {
          await fs.mkdir(paths.intentsDir, { recursive: true });
          const entry = {
            agent: params.agent ?? toolCtx.agentId ?? "unknown",
            text: params.text,
            timestamp: new Date().toISOString(),
          };
          await fs.appendFile(paths.activityLogPath, `${JSON.stringify(entry)}\n`, "utf8");
          return jsonResult({ logged: true, agent: entry.agent, timestamp: entry.timestamp });
        },
      }),
      { name: "log_activity" },
    );
  },
});

export default pluginEntry;
