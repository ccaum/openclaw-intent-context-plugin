import { Type, type Static } from "typebox";
import { definePluginEntry, buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import * as crypto from "node:crypto";

// Default values — all overridable via configSchema.
const DEFAULT_INTENTS_DIR = "~/.openclaw/intents";
const DEFAULT_ACTIVITY_WINDOW_MS = 6 * 60 * 60 * 1000;
const DEFAULT_LOG_RETENTION_MS = 48 * 60 * 60 * 1000;
const OPENCLAW_BIN = "/opt/homebrew/bin/openclaw";

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
    triggerTypes: Type.Optional(Type.Record(Type.String(), Type.String({
      description: "Description of when to use this trigger type.",
    }), {
      description: "Registry of valid trigger types. Keys are type strings, values are human-readable descriptions. Agents can only watch for registered types and create intents with registered types.",
    })),
    agents: Type.Record(Type.String(), AgentAwarenessConfigSchema, {
      description: "Per-agent awareness config, keyed by agentId.",
    }),
    recentActivityWindowMs: Type.Optional(Type.Number({ description: "How far back to surface ambient-activity entries. Default 6h." })),
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
}

export function resolvePaths(config: Pick<PluginConfig, "intentsDir">): IntentPaths {
  const intentsDir = path.resolve(expandHome(config.intentsDir ?? DEFAULT_INTENTS_DIR));
  return {
    intentsDir,
    pendingPath: path.join(intentsDir, "pending.json"),
    archivePath: path.join(intentsDir, "archive.json"),
    activityLogPath: path.join(intentsDir, "recent-activity.jsonl"),
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
  triggerTypes: Record<string, string> = {},
): Promise<string | null> {
  const sections: string[] = [];

  // Validate watchedTriggerTypes against registry
  if (agentConfig.watchedTriggerTypes && triggerTypes && Object.keys(triggerTypes).length > 0) {
    for (const t of agentConfig.watchedTriggerTypes) {
      if (!(t in triggerTypes)) {
        console.error(`[intent-context] Agent config has watchedTriggerType "${t}" but it is not in the triggerTypes registry. Valid types: ${Object.keys(triggerTypes).join(", ")}`);
      }
    }
  }

  if (agentConfig.watchedTriggerTypes && agentConfig.watchedTriggerTypes.length > 0) {
    const pending = await readJsonArray(paths.pendingPath);
    const watching = pending.filter(
      (item) => item.status === "pending" && agentConfig.watchedTriggerTypes!.includes(item.trigger?.type),
    );
    if (watching.length > 0) {
      sections.push(
        [
          "WATCHING FOR (pending intents in your domain — recognize a match, don't wait to be told). Load the `intent-context` skill and call `intent_update` with status=\"triggered\" when you see a match:",
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
          "ACTION NEEDED (triggered intents for you to act on):",
          ...acting.map((item) => {
            const title = item.title || item.description;
            let line = `- [${item.id}] ${title}`;
            if (item.trigger_message) {
              const from = item.triggered_by ?? "unknown";
              line += `\n  From ${from}: "${item.trigger_message}"`;
            }
            if (item.trigger_data && Object.keys(item.trigger_data).length > 0) {
              line += `\n  Data: ${JSON.stringify(item.trigger_data)}`;
            }
            return line;
          }),
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

async function pruneLogFile(filePath: string, retentionMs: number, now: number = Date.now()): Promise<void> {
  const entries = await readJsonLines(filePath);
  if (entries.length === 0) return;
  const kept = entries.filter((entry) => withinWindow(entry.timestamp, retentionMs, now));
  if (kept.length === entries.length) return;
  const body = kept.map((entry) => JSON.stringify(entry)).join("\n");
  await fs.writeFile(filePath, kept.length > 0 ? `${body}\n` : "", "utf8");
}

export async function pruneExpiredIntents(paths: IntentPaths): Promise<void> {
  const now = new Date().toISOString();
  const pending = await readJsonArray(paths.pendingPath);
  const active = pending.filter((intent: any) => {
    if (intent.expires_at && intent.status === "pending" && now > intent.expires_at) {
      return false; // expired
    }
    return true;
  });
  if (active.length !== pending.length) {
    await fs.writeFile(paths.pendingPath, JSON.stringify(active, null, 2));
  }
}

const pluginEntry: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "intent-context",
  name: "Intent Context",
  description:
    "Injects relevant intents, recent domain events, and ambient cross-agent activity into each configured agent's turn (before_prompt_build), and provides tools for logging activity and updating intent lifecycle. No active wake of any agent — everything surfaces on whatever turn happens next.",
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
      const agentConfig = config.agents?.[agentId] ?? config.agents?.[agentId.toLowerCase()];
      if (!agentConfig) return;
      const injection = await buildInjectionForAgent(agentConfig, paths, windows, Date.now(), config.triggerTypes || {});
      if (!injection) return;
      return { prependContext: injection };
    });

    let intervalHandle: ReturnType<typeof setInterval> | undefined;
    api.on("gateway_start", async () => {
      await fs.mkdir(paths.intentsDir, { recursive: true });
      const logRetentionMs = config.logRetentionMs ?? DEFAULT_LOG_RETENTION_MS;
      // Timer only prunes the activity log now — no more notify executor.
      intervalHandle = setInterval(() => {
        pruneLogFile(paths.activityLogPath, logRetentionMs).catch(() => {});
        pruneExpiredIntents(paths).catch(() => {});
      }, 60_000);
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

    api.registerTool(
      (toolCtx) => ({
        name: "intent_update",
        label: "Update Intent",
        description: "Update the status of an intent. Use status='triggered' when you recognize that a condition an intent is watching for has been met — this stores your message and any structured data on the intent and wakes the target agent so they can act on it. Use status='completed' when you have finished acting on a triggered intent assigned to you.",
        parameters: Type.Object({
          id: Type.String({
            minLength: 1,
            description: "The intent ID to update.",
          }),
          status: Type.Union([
            Type.Literal("triggered"),
            Type.Literal("completed"),
          ], {
            description: "New status: 'triggered' (condition met, notify target) or 'completed' (action taken, close out).",
          }),
          message: Type.Optional(Type.String({
            description: "Message for the target agent explaining what you saw and why you triggered the intent. Required when status='triggered'.",
            minLength: 1,
          })),
          trigger_data: Type.Optional(Type.Record(Type.String(), Type.Any(), {
            description: "Optional structured data to attach to the intent (e.g. {\"amount\": 500, \"merchant\": \"Acme\"}). Stored on the intent and visible to the target agent.",
          })),
        }),
        execute: async (_toolCallId: string, params: { id: string; status: "triggered" | "completed"; message?: string; trigger_data?: Record<string, any> }) => {
          await fs.mkdir(paths.intentsDir, { recursive: true });
          const pending = await readJsonArray(paths.pendingPath);
          const intent = pending.find((item) => item.id === params.id);
          if (!intent) {
            return jsonResult({ ok: false, error: `Intent ${params.id} not found` });
          }

          if (params.status === "triggered") {
            intent.status = "triggered";
            intent.trigger_data = params.trigger_data ?? {};
            intent.trigger_message = params.message;
            intent.triggered_at = new Date().toISOString();
            intent.triggered_by = toolCtx.agentId;
            await fs.writeFile(paths.pendingPath, JSON.stringify(pending, null, 2), "utf8");

            // Wake the target agent via openclaw system event.
            const notifyAgent = intent.notify_agent;
            if (notifyAgent) {
              try {
                const wakeMessage = `Intent ${params.id} triggered: ${params.message ?? ""}`;
                execSync(
                  `openclaw system event --session-key agent:${notifyAgent}:main --text "${wakeMessage.replace(/"/g, '\\"')}"`,
                  { timeout: 15000, stdio: "ignore" },
                );
              } catch (error) {
                // Wake failure doesn't fail the tool — injection will surface it on the target's next turn anyway.
                console.error(`[intent-context] failed to wake agent ${notifyAgent} for intent ${params.id}:`, error);
              }
            }
          } else if (params.status === "completed") {
            intent.status = "completed";
            intent.completed_at = new Date().toISOString();
            intent.completed_by = toolCtx.agentId;
            await fs.writeFile(paths.pendingPath, JSON.stringify(pending, null, 2), "utf8");
          }

          return jsonResult({ ok: true, intent: { id: params.id, status: params.status } });
        },
      }),
      { name: "intent_update" },
    );

    api.registerTool(
      (_toolCtx) => ({
        name: "list_trigger_types",
        label: "List Trigger Types",
        description: "List the valid trigger types that can be used when creating intents or configuring watchedTriggerTypes. Returns each type with its description.",
        parameters: Type.Object({}),
        execute: async () => {
          const types = config.triggerTypes || {};
          return jsonResult({ triggerTypes: types });
        },
      }),
      { name: "list_trigger_types" },
    );

    api.registerTool(
      (toolCtx) => ({
        name: "intent_create",
        label: "Create Intent",
        description: "Create a new pending intent for the system to watch for. The trigger type must be a registered type (use list_trigger_types to see valid types). The notify_agent is the agent that should be woken when the condition is met.",
        parameters: Type.Object({
          trigger_type: Type.String({
            minLength: 1,
            description: "The trigger type for this intent. Must be a registered type (see list_trigger_types).",
          }),
          trigger_data: Type.Optional(Type.Record(Type.String(), Type.Any(), {
            description: "Optional structured data describing what to watch for (e.g. {\"merchant\": \"Acme\", \"min_amount\": 200}).",
          })),
          description: Type.String({
            minLength: 1,
            description: "Human-readable description of what condition to watch for.",
          }),
          notify_agent: Type.String({
            minLength: 1,
            description: "The agent id that should be notified when this intent is triggered.",
          }),
          action_type: Type.Optional(Type.Union([
            Type.Literal("notify"),
            Type.Literal("agent_task"),
          ], {
            description: "What to do when triggered. 'notify' (default) just wakes the target agent. 'agent_task' surfaces it for the agent to decide.",
          })),
          action_message_template: Type.Optional(Type.String({
            description: "Optional message template for the notification. Use {{key}} placeholders that get filled from trigger_data when the intent is triggered.",
          })),
          expires_at: Type.Optional(Type.String({
            description: "ISO 8601 timestamp when this intent should expire if never triggered. Defaults to 24 hours from now. Use this for time-sensitive watch conditions.",
          })),
        }),
        execute: async (_toolCallId: string, params: {
          trigger_type: string;
          trigger_data?: Record<string, any>;
          description: string;
          notify_agent: string;
          action_type?: "notify" | "agent_task";
          action_message_template?: string;
          expires_at?: string;
        }) => {
          // Validate trigger_type against registry
          const validTypes = config.triggerTypes || {};
          if (!(params.trigger_type in validTypes)) {
            const validList = Object.entries(validTypes)
              .map(([k, v]) => `  ${k}: ${v}`)
              .join("\n");
            return jsonResult({
              ok: false,
              error: `Invalid trigger type: "${params.trigger_type}". Valid types are:\n${validList}`,
            });
          }

          // Read pending.json
          const pending = await readJsonArray(paths.pendingPath);

          // Default: 24 hours from now
          const expiresAt = params.expires_at || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

          // Create new intent
          const intent = {
            id: crypto.randomUUID(),
            status: "pending",
            trigger: {
              type: params.trigger_type,
              conditions: params.trigger_data || {},
            },
            description: params.description,
            notify_agent: params.notify_agent,
            action: {
              type: params.action_type || "notify",
              message_template: params.action_message_template || params.description,
            },
            created_at: new Date().toISOString(),
            created_by: toolCtx.agentId,
            expires_at: expiresAt,
          };

          pending.push(intent);
          await fs.writeFile(paths.pendingPath, JSON.stringify(pending, null, 2));

          return jsonResult({
            ok: true,
            intent: { id: intent.id, status: "pending" },
          });
        },
      }),
      { name: "intent_create" },
    );
  },
});

export default pluginEntry;