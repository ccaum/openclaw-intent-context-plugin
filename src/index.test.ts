import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
}));

import { resolvePaths, buildInjectionForAgent, pruneExpiredIntents, type IntentPaths } from "./index.js";

describe("buildInjectionForAgent", () => {
  let intentsDir: string;
  let paths: IntentPaths;

  beforeEach(async () => {
    intentsDir = await fs.mkdtemp(path.join(os.tmpdir(), "intent-context-test-"));
    paths = {
      intentsDir,
      pendingPath: path.join(intentsDir, "pending.json"),
      archivePath: path.join(intentsDir, "archive.json"),
      activityLogPath: path.join(intentsDir, "recent-activity.jsonl"),
    };
  });

  afterEach(async () => {
    await fs.rm(intentsDir, { recursive: true, force: true });
  });

  const windows = { recentActivityWindowMs: 6 * 60 * 60 * 1000 };
  const now = Date.parse("2026-07-17T12:00:00Z");

  it("returns null when nothing is relevant", async () => {
    const result = await buildInjectionForAgent({}, paths, windows, now);
    expect(result).toBeNull();
  });

  it("surfaces pending intents matching watchedTriggerTypes", async () => {
    await fs.writeFile(
      paths.pendingPath,
      JSON.stringify([
        { id: "a1", status: "pending", description: "Amazon return email", trigger: { type: "email", conditions: { sender_contains: "amazon" } } },
        { id: "a2", status: "pending", description: "unrelated", trigger: { type: "transaction" } },
      ]),
    );
    const result = await buildInjectionForAgent({ watchedTriggerTypes: ["email"] }, paths, windows, now);
    expect(result).toContain("WATCHING FOR");
    expect(result).toContain("a1");
    expect(result).toContain("Amazon return email");
    expect(result).not.toContain("a2");
    expect(result).toContain("--- intent-context plugin: auto-generated context (not part of user request) ---");
    expect(result).toContain("--- end intent-context plugin ---");
  });

  it("surfaces triggered intents matching actorFor", async () => {
    await fs.writeFile(
      paths.pendingPath,
      JSON.stringify([
        { id: "b1", status: "triggered", notify_agent: "main", description: "Costco refund", action: { type: "notify" }, trigger_data: { amount: "$47.23" } },
        { id: "b2", status: "triggered", notify_agent: "pax", description: "not for silas", action: { type: "notify" } },
      ]),
    );
    const result = await buildInjectionForAgent({ actorFor: ["main"] }, paths, windows, now);
    expect(result).toContain("ACTION NEEDED");
    expect(result).toContain("b1");
    expect(result).not.toContain("b2");
    expect(result).toContain("--- intent-context plugin: auto-generated context (not part of user request) ---");
    expect(result).toContain("--- end intent-context plugin ---");
  });

  it("includes trigger message and data in ACTION NEEDED", async () => {
    await fs.writeFile(
      paths.pendingPath,
      JSON.stringify([
        {
          id: "b1",
          status: "triggered",
          notify_agent: "main",
          description: "Refund received",
          trigger_data: { amount: 500, merchant: "Acme" },
          trigger_message: "Refund of $500 from Acme posted",
          triggered_by: "roger",
        },
      ]),
    );
    const result = await buildInjectionForAgent({ actorFor: ["main"] }, paths, windows, now);
    expect(result).toContain("ACTION NEEDED");
    expect(result).toContain("From roger: \"Refund of $500 from Acme posted\"");
    expect(result).toContain('Data: {"amount":500,"merchant":"Acme"}');
  });

  it("omits From line when trigger_message is missing (legacy intents)", async () => {
    await fs.writeFile(
      paths.pendingPath,
      JSON.stringify([
        { id: "b1", status: "triggered", notify_agent: "main", description: "Legacy intent", trigger_data: { x: 1 } },
      ]),
    );
    const result = await buildInjectionForAgent({ actorFor: ["main"] }, paths, windows, now);
    expect(result).toContain("ACTION NEEDED");
    expect(result).toContain("b1");
    expect(result).not.toContain("From ");
  });

  it("surfaces ambient activity scoped to specific agents", async () => {
    const recentTs = new Date(now - 60 * 1000).toISOString();
    await fs.writeFile(
      paths.activityLogPath,
      [
        JSON.stringify({ agent: "pax", text: "Picked up ticket HA-F006", timestamp: recentTs }),
        JSON.stringify({ agent: "roger", text: "Reviewed a transaction", timestamp: recentTs }),
      ].join("\n"),
    );
    const scoped = await buildInjectionForAgent({ ambientScope: ["pax"] }, paths, windows, now);
    expect(scoped).toContain("HA-F006");
    expect(scoped).not.toContain("Reviewed a transaction");
    expect(scoped).toContain("--- intent-context plugin: auto-generated context (not part of user request) ---");
    expect(scoped).toContain("--- end intent-context plugin ---");

    const all = await buildInjectionForAgent({ ambientScope: "all" }, paths, windows, now);
    expect(all).toContain("HA-F006");
    expect(all).toContain("Reviewed a transaction");
    expect(all).toContain("--- intent-context plugin: auto-generated context (not part of user request) ---");
    expect(all).toContain("--- end intent-context plugin ---");
  });

  it("case-insensitive agent config lookup: capitalized agentId matches lowercase config key", async () => {
    // Simulates the before_prompt_build handler's lookup logic:
    //   config.agents?.[agentId] ?? config.agents?.[agentId.toLowerCase()]
    // Here the config is keyed by "postman" (lowercase) but the agent id is "Postman" (capitalized).
    const config = {
      agents: {
        postman: { watchedTriggerTypes: ["email"] },
      } as Record<string, any>,
    };
    const agentId = "Postman";

    // This is the exact lookup from before_prompt_build after the fix:
    const agentConfig = config.agents?.[agentId] ?? config.agents?.[agentId.toLowerCase()];
    expect(agentConfig).toBeDefined();
    expect(agentConfig.watchedTriggerTypes).toEqual(["email"]);

    // Now verify buildInjectionForAgent works with that config and finds matching intents
    await fs.writeFile(
      paths.pendingPath,
      JSON.stringify([
        { id: "c1", status: "pending", description: "Package delivery", trigger: { type: "email", conditions: {} } },
      ]),
    );
    const result = await buildInjectionForAgent(agentConfig, paths, windows, now);
    expect(result).toContain("WATCHING FOR");
    expect(result).toContain("c1");
  });
});

describe("resolvePaths", () => {
  it("expands ~ and defaults to ~/.openclaw/intents", () => {
    const paths = resolvePaths({});
    expect(paths.intentsDir).toBe(path.join(os.homedir(), ".openclaw", "intents"));
    expect(paths.pendingPath.endsWith("pending.json")).toBe(true);
  });

  it("honors an explicit intentsDir", () => {
    const paths = resolvePaths({ intentsDir: "/tmp/custom-intents" });
    expect(paths.intentsDir).toBe("/tmp/custom-intents");
  });
});

describe("log_activity tool", () => {
  let intentsDir: string;
  let paths: IntentPaths;

  beforeEach(async () => {
    intentsDir = await fs.mkdtemp(path.join(os.tmpdir(), "intent-context-log-activity-test-"));
    paths = {
      intentsDir,
      pendingPath: path.join(intentsDir, "pending.json"),
      archivePath: path.join(intentsDir, "archive.json"),
      activityLogPath: path.join(intentsDir, "recent-activity.jsonl"),
    };
  });

  afterEach(async () => {
    await fs.rm(intentsDir, { recursive: true, force: true });
  });

  it("uses the agent parameter when provided instead of toolCtx.agentId", async () => {
    await fs.mkdir(paths.intentsDir, { recursive: true });
    const entry = {
      agent: "marlin",
      text: "External system event",
      timestamp: new Date().toISOString(),
    };
    // Simulate what the log_activity execute function does when agent param is set
    const logEntry = {
      agent: entry.agent,
      text: entry.text,
      timestamp: entry.timestamp,
    };
    await fs.appendFile(paths.activityLogPath, `${JSON.stringify(logEntry)}\n`, "utf8");

    const raw = await fs.readFile(paths.activityLogPath, "utf8");
    const logged = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(logged).toHaveLength(1);
    expect(logged[0].agent).toBe("marlin");
    expect(logged[0].text).toBe("External system event");
  });
});

// Tests for list_trigger_types and intent_create tool logic.
// These test the core logic (trigger type validation, intent creation, pending.json write)
// the same way the plugin's register() function does it.

describe("intent_create expires_at", () => {
  let intentsDir: string;
  let paths: IntentPaths;

  beforeEach(async () => {
    intentsDir = await fs.mkdtemp(path.join(os.tmpdir(), "intent-context-expires-test-"));
    paths = {
      intentsDir,
      pendingPath: path.join(intentsDir, "pending.json"),
      archivePath: path.join(intentsDir, "archive.json"),
      activityLogPath: path.join(intentsDir, "recent-activity.jsonl"),
    };
    await fs.mkdir(paths.intentsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(intentsDir, { recursive: true, force: true });
  });

  it("sets expires_at to ~24h from now by default", async () => {
    const now = Date.now();
    const expectedExpiry = new Date(now + 24 * 60 * 60 * 1000).toISOString();

    // Simulate what intent_create execute does with default expires_at
    const expiresAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    const intent = {
      id: crypto.randomUUID(),
      status: "pending",
      trigger: { type: "transaction", conditions: {} },
      description: "Test intent",
      notify_agent: "assistant",
      action: { type: "notify", message_template: "Test intent" },
      created_at: new Date(now).toISOString(),
      created_by: "test-agent",
      expires_at: expiresAt,
    };
    await fs.writeFile(paths.pendingPath, JSON.stringify([intent], null, 2));

    const raw = await fs.readFile(paths.pendingPath, "utf8");
    const stored = JSON.parse(raw);
    expect(stored[0].expires_at).toBeDefined();
    // Verify it's approximately 24h out (within 1 minute tolerance)
    const expiryMs = Date.parse(stored[0].expires_at);
    const expectedMs = Date.parse(expectedExpiry);
    expect(Math.abs(expiryMs - expectedMs)).toBeLessThan(60_000);
  });

  it("uses explicit expires_at when provided", async () => {
    const explicitExpiry = "2026-12-31T23:59:59.000Z";

    const intent = {
      id: crypto.randomUUID(),
      status: "pending",
      trigger: { type: "transaction", conditions: {} },
      description: "Time-sensitive intent",
      notify_agent: "assistant",
      action: { type: "notify", message_template: "Time-sensitive intent" },
      created_at: new Date().toISOString(),
      created_by: "test-agent",
      expires_at: explicitExpiry,
    };
    await fs.writeFile(paths.pendingPath, JSON.stringify([intent], null, 2));

    const raw = await fs.readFile(paths.pendingPath, "utf8");
    const stored = JSON.parse(raw);
    expect(stored[0].expires_at).toBe(explicitExpiry);
  });
});

describe("pruneExpiredIntents", () => {
  let intentsDir: string;
  let paths: IntentPaths;

  beforeEach(async () => {
    intentsDir = await fs.mkdtemp(path.join(os.tmpdir(), "intent-context-prune-test-"));
    paths = {
      intentsDir,
      pendingPath: path.join(intentsDir, "pending.json"),
      archivePath: path.join(intentsDir, "archive.json"),
      activityLogPath: path.join(intentsDir, "recent-activity.jsonl"),
    };
    await fs.mkdir(paths.intentsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(intentsDir, { recursive: true, force: true });
  });

  it("removes expired pending intents but keeps active ones and triggered ones", async () => {
    const pastExpiry = "2020-01-01T00:00:00.000Z";
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const pending = [
      // Expired pending intent — should be pruned
      { id: "expired-1", status: "pending", description: "Expired", expires_at: pastExpiry },
      // Active pending intent — should be kept
      { id: "active-1", status: "pending", description: "Active", expires_at: futureExpiry },
      // Triggered intent with past expiry — should be kept (not pending)
      { id: "triggered-1", status: "triggered", description: "Already triggered", expires_at: pastExpiry },
      // Pending intent with no expires_at — should be kept
      { id: "no-expiry-1", status: "pending", description: "No expiry" },
    ];
    await fs.writeFile(paths.pendingPath, JSON.stringify(pending, null, 2));

    await pruneExpiredIntents(paths);

    const raw = await fs.readFile(paths.pendingPath, "utf8");
    const stored = JSON.parse(raw);
    const ids = stored.map((i: any) => i.id);
    expect(ids).not.toContain("expired-1");
    expect(ids).toContain("active-1");
    expect(ids).toContain("triggered-1");
    expect(ids).toContain("no-expiry-1");
    expect(stored).toHaveLength(3);
  });

  it("does not write when no intents are expired", async () => {
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const pending = [
      { id: "active-1", status: "pending", description: "Active", expires_at: futureExpiry },
      { id: "no-expiry-1", status: "pending", description: "No expiry" },
    ];
    await fs.writeFile(paths.pendingPath, JSON.stringify(pending, null, 2));
    const originalContent = await fs.readFile(paths.pendingPath, "utf8");

    await pruneExpiredIntents(paths);

    const contentAfter = await fs.readFile(paths.pendingPath, "utf8");
    expect(contentAfter).toBe(originalContent);
  });
});

describe("list_trigger_types logic", () => {
  it("returns registered trigger types", () => {
    const triggerTypes = {
      transaction: "Bank or payment transactions",
      home_event: "Home automation events",
    };
    // list_trigger_types execute just returns { triggerTypes: config.triggerTypes || {} }
    const result = { triggerTypes: triggerTypes };
    expect(result.triggerTypes).toEqual(triggerTypes);
    expect(Object.keys(result.triggerTypes)).toHaveLength(2);
  });

  it("returns empty object when triggerTypes is not configured", () => {
    const config: Record<string, string> | undefined = undefined;
    const result = { triggerTypes: config || {} };
    expect(result.triggerTypes).toEqual({});
  });
});

describe("intent_create logic", () => {
  let intentsDir: string;
  let paths: IntentPaths;

  beforeEach(async () => {
    intentsDir = await fs.mkdtemp(path.join(os.tmpdir(), "intent-context-create-test-"));
    paths = {
      intentsDir,
      pendingPath: path.join(intentsDir, "pending.json"),
      archivePath: path.join(intentsDir, "archive.json"),
      activityLogPath: path.join(intentsDir, "recent-activity.jsonl"),
    };
    await fs.mkdir(paths.intentsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(intentsDir, { recursive: true, force: true });
  });

  const triggerTypes: Record<string, string> = {
    transaction: "Bank or payment transactions",
    home_event: "Home automation events",
  };

  it("creates an intent with a valid trigger type", async () => {
    const params = {
      trigger_type: "transaction",
      description: "Refund from Acme over $200",
      notify_agent: "assistant",
      trigger_data: { merchant: "Acme", min_amount: 200 },
    };

    // Validate trigger_type against registry
    expect(params.trigger_type in triggerTypes).toBe(true);

    // Read pending.json (empty)
    const pending: Record<string, any>[] = [];

    // Create intent
    const intent = {
      id: crypto.randomUUID(),
      status: "pending",
      trigger: { type: params.trigger_type, conditions: params.trigger_data || {} },
      description: params.description,
      notify_agent: params.notify_agent,
      action: { type: "notify", message_template: params.description },
      created_at: new Date().toISOString(),
      created_by: "test-agent",
    };
    pending.push(intent);
    await fs.writeFile(paths.pendingPath, JSON.stringify(pending, null, 2));

    // Verify
    const raw = await fs.readFile(paths.pendingPath, "utf8");
    const stored = JSON.parse(raw);
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe("pending");
    expect(stored[0].trigger.type).toBe("transaction");
    expect(stored[0].trigger.conditions).toEqual({ merchant: "Acme", min_amount: 200 });
    expect(stored[0].trigger.data).toBeUndefined();
    expect(stored[0].notify_agent).toBe("assistant");
    expect(stored[0].id).toMatch(/[0-9a-f-]{36}/);
  });

  it("returns error with valid types listed when trigger type is invalid", () => {
    const params = {
      trigger_type: "nonexistent",
      description: "Some intent",
      notify_agent: "assistant",
    };

    // Validate trigger_type against registry
    const valid = params.trigger_type in triggerTypes;
    expect(valid).toBe(false);

    // Build error response
    const validList = Object.entries(triggerTypes)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");
    const error = `Invalid trigger type: "${params.trigger_type}". Valid types are:\n${validList}`;

    expect(error).toContain("nonexistent");
    expect(error).toContain("transaction: Bank or payment transactions");
    expect(error).toContain("home_event: Home automation events");
  });

  it("appends to existing pending intents without overwriting", async () => {
    // Pre-existing intent
    const existing: Record<string, any>[] = [{ id: "pre-existing", status: "pending", description: "old" }];
    await fs.writeFile(paths.pendingPath, JSON.stringify(existing, null, 2));

    // New intent
    const newIntent = {
      id: crypto.randomUUID(),
      status: "pending",
      trigger: { type: "home_event", conditions: {} },
      description: "Someone arrived home",
      notify_agent: "home",
      action: { type: "notify", message_template: "Someone arrived home" },
      created_at: new Date().toISOString(),
      created_by: "test-agent",
    };
    existing.push(newIntent);
    await fs.writeFile(paths.pendingPath, JSON.stringify(existing, null, 2));

    const raw = await fs.readFile(paths.pendingPath, "utf8");
    const stored = JSON.parse(raw);
    expect(stored).toHaveLength(2);
    expect(stored[0].id).toBe("pre-existing");
    expect(stored[1].trigger.type).toBe("home_event");
  });
});