import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const execFileCalls: { cmd: string; args: string[] }[] = [];
let execFileShouldFail = false;

vi.mock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void,
  ) => {
    execFileCalls.push({ cmd, args });
    if (execFileShouldFail) {
      cb(new Error("simulated failure"));
    } else {
      cb(null, { stdout: "", stderr: "" });
    }
  },
}));

import { resolvePaths, subjectMatchesDomain, buildInjectionForAgent, runNotifyExecutor, withIntentsLock, type IntentPaths } from "./index.js";

describe("subjectMatchesDomain", () => {
  it("matches exact subjects", () => {
    expect(subjectMatchesDomain("events.home.arrival", "events.home.arrival")).toBe(true);
  });

  it("matches a trailing > wildcard", () => {
    expect(subjectMatchesDomain("events.home.arrival", "events.home.>")).toBe(true);
    expect(subjectMatchesDomain("events.home.arrival.extra", "events.home.>")).toBe(true);
  });

  it("matches a single-token * wildcard", () => {
    expect(subjectMatchesDomain("events.home.arrival", "events.*.arrival")).toBe(true);
    expect(subjectMatchesDomain("events.home.arrival.extra", "events.*.arrival")).toBe(false);
  });

  it("rejects non-matching subjects", () => {
    expect(subjectMatchesDomain("events.finance.transaction", "events.home.>")).toBe(false);
  });
});

describe("buildInjectionForAgent", () => {
  let intentsDir: string;
  let paths: IntentPaths;

  beforeEach(async () => {
    intentsDir = await fs.mkdtemp(path.join(os.tmpdir(), "intent-context-test-"));
    paths = {
      intentsDir,
      pendingPath: path.join(intentsDir, "pending.json"),
      archivePath: path.join(intentsDir, "archive.json"),
      eventsLogPath: path.join(intentsDir, "recent-events.jsonl"),
      activityLogPath: path.join(intentsDir, "recent-activity.jsonl"),
      lockDir: path.join(intentsDir, ".lock"),
    };
  });

  afterEach(async () => {
    await fs.rm(intentsDir, { recursive: true, force: true });
  });

  const windows = { recentEventsWindowMs: 24 * 60 * 60 * 1000, recentActivityWindowMs: 6 * 60 * 60 * 1000 };
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
    expect(result).toContain("--- AUTO-GENERATED CONTEXT (not part of user request) ---");
    expect(result).toContain("--- END AUTO-GENERATED CONTEXT ---");
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
    expect(result).toContain("--- AUTO-GENERATED CONTEXT (not part of user request) ---");
    expect(result).toContain("--- END AUTO-GENERATED CONTEXT ---");
  });

  it("surfaces recent events within window matching eventDomains", async () => {
    const recentTs = new Date(now - 60 * 1000).toISOString();
    const staleTs = new Date(now - 48 * 60 * 60 * 1000).toISOString();
    await fs.writeFile(
      paths.eventsLogPath,
      [
        JSON.stringify({ subject: "events.home.arrival", payload: { person: "Carl" }, timestamp: recentTs }),
        JSON.stringify({ subject: "events.home.arrival", payload: { person: "stale" }, timestamp: staleTs }),
        JSON.stringify({ subject: "events.finance.transaction", payload: {}, timestamp: recentTs }),
      ].join("\n"),
    );
    const result = await buildInjectionForAgent({ eventDomains: ["events.home.>"] }, paths, windows, now);
    expect(result).toContain("RECENT EVENTS");
    expect(result).toContain("Carl");
    expect(result).not.toContain("stale");
    expect(result).not.toContain("finance");
    expect(result).toContain("--- AUTO-GENERATED CONTEXT (not part of user request) ---");
    expect(result).toContain("--- END AUTO-GENERATED CONTEXT ---");
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
    expect(scoped).toContain("--- AUTO-GENERATED CONTEXT (not part of user request) ---");
    expect(scoped).toContain("--- END AUTO-GENERATED CONTEXT ---");

    const all = await buildInjectionForAgent({ ambientScope: "all" }, paths, windows, now);
    expect(all).toContain("HA-F006");
    expect(all).toContain("Reviewed a transaction");
    expect(all).toContain("--- AUTO-GENERATED CONTEXT (not part of user request) ---");
    expect(all).toContain("--- END AUTO-GENERATED CONTEXT ---");
  });
});

describe("runNotifyExecutor", () => {
  let intentsDir: string;
  let paths: IntentPaths;

  beforeEach(async () => {
    intentsDir = await fs.mkdtemp(path.join(os.tmpdir(), "intent-context-notify-test-"));
    paths = {
      intentsDir,
      pendingPath: path.join(intentsDir, "pending.json"),
      archivePath: path.join(intentsDir, "archive.json"),
      eventsLogPath: path.join(intentsDir, "recent-events.jsonl"),
      activityLogPath: path.join(intentsDir, "recent-activity.jsonl"),
      lockDir: path.join(intentsDir, ".lock"),
    };
    execFileCalls.length = 0;
    execFileShouldFail = false;
  });

  afterEach(async () => {
    await fs.rm(intentsDir, { recursive: true, force: true });
  });

  it("executes a triggered notify intent and marks it completed", async () => {
    await fs.writeFile(
      paths.pendingPath,
      JSON.stringify([
        {
          id: "c1",
          status: "triggered",
          description: "Costco refund",
          action: { type: "notify", channel: "bluebubbles", target: "carl", message_template: "Refund posted: {{amount}}" },
          trigger_data: { amount: "$47.23" },
        },
      ]),
    );
    await fs.writeFile(paths.archivePath, JSON.stringify([]));

    const result = await runNotifyExecutor(paths);

    expect(result.processed).toBe(1);
    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0].args).toContain("Refund posted: $47.23");

    const pending = JSON.parse(await fs.readFile(paths.pendingPath, "utf8"));
    expect(pending[0].status).toBe("completed");
    expect(pending[0].completed_at).toBeDefined();
  });

  it("does not execute agent_task intents", async () => {
    await fs.writeFile(
      paths.pendingPath,
      JSON.stringify([{ id: "d1", status: "triggered", description: "install build", action: { type: "agent_task", agent: "pax" } }]),
    );
    await fs.writeFile(paths.archivePath, JSON.stringify([]));

    const result = await runNotifyExecutor(paths);

    expect(result.processed).toBe(0);
    expect(execFileCalls).toHaveLength(0);
    const pending = JSON.parse(await fs.readFile(paths.pendingPath, "utf8"));
    expect(pending[0].status).toBe("triggered");
  });

  it("marks completed even when the send fails, recording the failure", async () => {
    execFileShouldFail = true;
    await fs.writeFile(
      paths.pendingPath,
      JSON.stringify([{ id: "e1", status: "triggered", description: "test", action: { type: "notify" } }]),
    );
    await fs.writeFile(paths.archivePath, JSON.stringify([]));

    await runNotifyExecutor(paths);

    const pending = JSON.parse(await fs.readFile(paths.pendingPath, "utf8"));
    expect(pending[0].status).toBe("completed");
    expect(pending[0].completion_result).toContain("Failed");
  });

  it("is a no-op when there is nothing triggered", async () => {
    await fs.writeFile(paths.pendingPath, JSON.stringify([{ id: "f1", status: "pending", action: { type: "notify" } }]));
    await fs.writeFile(paths.archivePath, JSON.stringify([]));

    const result = await runNotifyExecutor(paths);

    expect(result.processed).toBe(0);
    expect(execFileCalls).toHaveLength(0);
  });

  it("reclaims a stale lock and processes intents", async () => {
    // Create a stale lock: directory with a lock.meta that has an old timestamp.
    await fs.mkdir(paths.lockDir);
    const staleMeta = { pid: 99999, startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() };
    await fs.writeFile(path.join(paths.lockDir, "lock.meta"), JSON.stringify(staleMeta), "utf8");

    await fs.writeFile(
      paths.pendingPath,
      JSON.stringify([
        {
          id: "stale-1",
          status: "triggered",
          description: "stale lock test",
          action: { type: "notify", channel: "bluebubbles", message_template: "Stale: {{x}}" },
          trigger_data: { x: "reclaimed" },
        },
      ]),
    );
    await fs.writeFile(paths.archivePath, JSON.stringify([]));

    const result = await runNotifyExecutor(paths);

    expect(result.processed).toBe(1);
    // The stale lock should have been reclaimed and cleaned up.
    const lockExists = await fs.access(paths.lockDir).then(() => true).catch(() => false);
    expect(lockExists).toBe(false);
  });

  it("uses config-overridden openclawBin path", async () => {
    await fs.writeFile(
      paths.pendingPath,
      JSON.stringify([
        {
          id: "g1",
          status: "triggered",
          description: "custom bin test",
          action: { type: "notify", channel: "bluebubbles", target: "carl", message_template: "Hi" },
          trigger_data: {},
        },
      ]),
    );
    await fs.writeFile(paths.archivePath, JSON.stringify([]));

    await runNotifyExecutor(paths, { openclawBin: "/custom/path/openclaw" });

    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0].cmd).toBe("/custom/path/openclaw");
  });

  it("uses config-overridden fallbackNotifyChannel when action.channel is unset", async () => {
    await fs.writeFile(
      paths.pendingPath,
      JSON.stringify([
        {
          id: "h1",
          status: "triggered",
          description: "fallback channel test",
          action: { type: "notify", target: "carl", message_template: "Hi" },
          trigger_data: {},
        },
      ]),
    );
    await fs.writeFile(paths.archivePath, JSON.stringify([]));

    await runNotifyExecutor(paths, { fallbackNotifyChannel: "discord" });

    expect(execFileCalls).toHaveLength(1);
    const channelArg = execFileCalls[0].args[execFileCalls[0].args.indexOf("--channel") + 1];
    expect(channelArg).toBe("discord");

    const pending = JSON.parse(await fs.readFile(paths.pendingPath, "utf8"));
    expect(pending[0].completion_result).toContain("discord");
  });

  it("defaults to bluebubbles fallback channel when neither config nor action.channel is set", async () => {
    await fs.writeFile(
      paths.pendingPath,
      JSON.stringify([
        {
          id: "i1",
          status: "triggered",
          description: "default fallback test",
          action: { type: "notify", target: "carl", message_template: "Hi" },
          trigger_data: {},
        },
      ]),
    );
    await fs.writeFile(paths.archivePath, JSON.stringify([]));

    await runNotifyExecutor(paths);

    expect(execFileCalls).toHaveLength(1);
    const channelArg = execFileCalls[0].args[execFileCalls[0].args.indexOf("--channel") + 1];
    expect(channelArg).toBe("bluebubbles");
  });

  it("surfaces lock-acquisition failure via openclaw message send when lock is not stale", async () => {
    // Create a fresh (non-stale) lock that persists through all retries.
    await fs.mkdir(paths.lockDir);
    const freshMeta = { pid: 12345, startedAt: new Date().toISOString() };
    await fs.writeFile(path.join(paths.lockDir, "lock.meta"), JSON.stringify(freshMeta), "utf8");

    await fs.writeFile(paths.pendingPath, JSON.stringify([]));
    await fs.writeFile(paths.archivePath, JSON.stringify([]));

    // Use a short stale threshold and short retry delay to keep the test fast.
    // We pass staleMs=999999999 so the lock is never considered stale (simulating a live holder).
    await expect(
      withIntentsLock(
        paths.lockDir,
        async () => 42,
        { staleMs: 999999999, onLockFailure: async () => {} },
      ),
    ).rejects.toThrow(/Could not acquire intents lock/);

    // The lock directory should still exist (we didn't reclaim it).
    const lockExists = await fs.access(paths.lockDir).then(() => true).catch(() => false);
    expect(lockExists).toBe(true);
  });
});

describe("withIntentsLock", () => {
  let tmpDir: string;
  let lockDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "intent-context-lock-test-"));
    lockDir = path.join(tmpDir, ".lock");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("acquires a fresh lock and releases it", async () => {
    const result = await withIntentsLock(lockDir, async () => "done");
    expect(result).toBe("done");
    // Lock should be cleaned up.
    const exists = await fs.access(lockDir).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it("reclaims a stale lock (no meta file) and proceeds", async () => {
    // Create lock dir with no meta file — treated as stale.
    await fs.mkdir(lockDir);

    const result = await withIntentsLock(lockDir, async () => "reclaimed", { staleMs: 1000 });
    expect(result).toBe("reclaimed");
    const exists = await fs.access(lockDir).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it("reclaims a stale lock (old timestamp in meta)", async () => {
    await fs.mkdir(lockDir);
    const staleMeta = { pid: 99999, startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() };
    await fs.writeFile(path.join(lockDir, "lock.meta"), JSON.stringify(staleMeta), "utf8");

    const result = await withIntentsLock(lockDir, async () => "reclaimed", { staleMs: 5000 });
    expect(result).toBe("reclaimed");
    const exists = await fs.access(lockDir).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it("throws when lock is held and not stale", async () => {
    await fs.mkdir(lockDir);
    const freshMeta = { pid: 12345, startedAt: new Date().toISOString() };
    await fs.writeFile(path.join(lockDir, "lock.meta"), JSON.stringify(freshMeta), "utf8");

    await expect(
      withIntentsLock(lockDir, async () => "x", { staleMs: 999999999 }),
    ).rejects.toThrow(/Could not acquire intents lock/);

    // Lock dir should still be there.
    const exists = await fs.access(lockDir).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it("calls onLockFailure when lock acquisition fails", async () => {
    await fs.mkdir(lockDir);
    const freshMeta = { pid: 12345, startedAt: new Date().toISOString() };
    await fs.writeFile(path.join(lockDir, "lock.meta"), JSON.stringify(freshMeta), "utf8");

    let failureMsg = "";
    await expect(
      withIntentsLock(
        lockDir,
        async () => "x",
        {
          staleMs: 999999999,
          onLockFailure: async (msg: string) => { failureMsg = msg; },
        },
      ),
    ).rejects.toThrow();

    expect(failureMsg).toContain("Could not acquire intents lock");
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
