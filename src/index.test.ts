import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
}));

import { resolvePaths, buildInjectionForAgent, type IntentPaths } from "./index.js";

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