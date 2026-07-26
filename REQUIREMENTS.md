# IC-F002 — Retire NATS, Unify Event Ingestion on log_activity

## Problem

The intent-context plugin has two context injection paths:

1. **RECENT ACTIVITY** — reads `recent-activity.jsonl`, written by the `log_activity` tool. Works great. Self-contained. No external dependencies.
2. **RECENT EVENTS** — reads `recent-events.jsonl`, written by `nats-bridge` (a separate Go process) which consumes from a `nats-server` message bus. `marlin-pipeline` publishes home arrival/departure events to NATS. The bridge consumes them and appends to the log file.

The NATS path is infrastructure overhead for no value:
- 3 always-on processes (nats-server, nats-bridge, nats-health) for a path that's produced 2 messages total in 4 months
- A separate Go project (nats-bridge) with its own build, config, and failure modes
- Complex failure surface: stale locks, silent empty reads, no hot-reload of timers
- The plugin itself has zero NATS dependency — it just reads a file

Meanwhile, `log_activity` already works as a general-purpose event ingestion mechanism. Any agent can call it. The `/tools/invoke` HTTP endpoint already exposes it to external systems. We just need to let external systems identify themselves.

## Solution

1. **Remove the RECENT EVENTS code path from intent-context entirely.** Strip `subjectMatchesDomain`, `eventDomains` config, `eventsLogPath` reading, `recentEventsWindowMs`, and the `recent-events.jsonl` pruning logic. The plugin becomes simpler.

2. **Add optional `agent` parameter to the `log_activity` tool.** Currently `agent` is pulled from `toolCtx.agentId` (the calling session's agent). For HTTP `/tools/invoke` calls from external systems, there's no agent session — it logs as `"unknown"`. An explicit `agent` parameter lets marlin-pipeline (or any external system) identify itself.

3. **Update marlin-pipeline** to replace `nats pub` calls with HTTP POST to `/tools/invoke` calling `log_activity`. The pipeline already shells out to CLI commands (`nats pub`), so replacing with `curl` is equivalent complexity.

4. **Shut down and remove NATS infrastructure:** nats-server, nats-bridge, nats-health launchd plists and processes.

5. **Create a public GitHub repo** for intent-context with an accurate README.

6. **Prepare for ClawHub publishing.**

## Requirements

### R1: Remove RECENT EVENTS from intent-context
- Remove `subjectMatchesDomain` function and its test
- Remove `eventDomains` from `AgentAwarenessConfigSchema`
- Remove `eventDomains` filtering block from `buildInjectionForAgent`
- Remove `eventsLogPath` from `IntentPaths` and `resolvePaths`
- Remove `recentEventsWindowMs` from config and defaults
- Remove `DEFAULT_EVENTS_WINDOW_MS` constant
- Remove `recent-events.jsonl` pruning from the `gateway_start` timer
- Remove `recentEventsWindowMs` from `ConfigSchema`
- Update tests: remove `subjectMatchesDomain` describe block, update `buildInjectionForAgent` tests to remove event-domain cases
- Remove `eventDomains` from all agent configs in `openclaw.json`

### R2: Add `agent` parameter to log_activity tool
- Add optional `agent` string parameter to the `log_activity` tool schema
- When `agent` parameter is provided, use it instead of `toolCtx.agentId`
- When `agent` parameter is omitted, behavior unchanged (use `toolCtx.agentId ?? "unknown"`)
- Add tests for both paths

### R3: Update marlin-pipeline
- Replace `PublishNATSEvent` in `notify.go` with a `LogActivity` method that POSTs to `http://127.0.0.1:18789/tools/invoke`
- Update `daemon.go` to call `LogActivity` instead of `PublishNATSEvent`
- Include agent identifier (`"marlin"`) and event details in the activity text
- Remove `nats` CLI dependency from marlin-pipeline
- Remove `setup-nats-consumers.sh` and `test_scout_nats.sh` scripts

### R4: Shut down NATS infrastructure
- Stop and unload `com.openclaw.nats-server`, `com.openclaw.nats-bridge`, `com.openclaw.nats-health` launchd agents
- Remove the plist files from `~/Library/LaunchAgents/`
- Kill any running NATS processes
- Remove `~/.openclaw/nats/` directory (server config and data)
- Remove `~/.openclaw/intents/recent-events.jsonl` (empty file, no data loss)
- Archive or remove `~/.openclaw/workspace-pax/projects/nats-bridge/` Go project

### R5: Public GitHub repo
- Initialize git repo in `~/.openclaw/workspace-pax/projects/intent-context/` (already has .git)
- Create public GitHub repo: `openclaw/intent-context` (or appropriate org)
- Push to GitHub
- Remove any private/internal references from code and config
- Add LICENSE file (MIT or matching OpenClaw core)
- Add .gitignore for node_modules and dist

### R6: Update README
- Replace stale boilerplate README with accurate documentation:
  - What the plugin does (context injection + notify executor + log_activity tool)
  - How it works (before_prompt_build hook, gateway_start timer, tool registration)
  - Configuration (configSchema with all fields documented)
  - Build instructions (npm install, npm test, npm run plugin:build — NOT openclaw plugins build)
  - Installation (copy to plugins dir, add to openclaw.json, gateway restart)
  - The `log_activity` tool and how external systems can call it via /tools/invoke
  - Architecture decisions (passive injection, no active wake, file-based data)

### R7: Prepare for ClawHub
- Verify `openclaw.plugin.json` manifest is complete and accurate
- Run `clawhub skill publish` dry run or equivalent validation
- Ensure package.json metadata is correct (name, version, description, repo URL)

## Acceptance Criteria

1. `npm test` passes with all remaining tests green (subjectMatchesDomain tests removed, agent param tests added)
2. Plugin loads successfully after `openclaw gateway restart`
3. `log_activity` tool accepts optional `agent` parameter — verified via `/tools/invoke` HTTP call with `agent: "test-system"`
4. No references to NATS, events, `recent-events`, `subjectMatchesDomain`, or `eventDomains` remain in intent-context source or config
5. `nats-server`, `nats-bridge`, `nats-health` processes are not running
6. Launchd plists for NATS are removed
7. marlin-pipeline successfully publishes activity via `/tools/invoke` (verified with a test event)
8. Public GitHub repo exists with accurate README
9. `clawhub` validation passes (or dry run shows no errors)

## Out of Scope

- Rewriting nats-bridge (it's being retired, not migrated)
- Changes to the intent system itself (pending.json, archive.json, triggered intents)
- Changes to other plugins or agents
- The nats-bridge reconciler logic (dies with the bridge, not worth migrating)