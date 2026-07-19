# intent-context — Project Index

_Last updated: 2026-07-19_
_Stale after: 2026-08-02 (14 days) — verify before trusting_

## Overview

`intent-context` is a compiled TypeScript OpenClaw plugin that gives agents passive
awareness of each other and of the intent/event system. It does two things: a
`before_prompt_build` hook injects relevant pending intents, recent NATS events, and
ambient cross-agent activity into a configured agent's turn; and a `gateway_start`
timer mechanically executes `notify`-type triggered intents via `openclaw message send`.
**No agent is ever actively woken** — everything surfaces on whatever turn happens next.
Built by Carl (via Claude Code) 2026-07-17/18, handed to Pax 2026-07-19. Status:
deployed and loaded; ambient-activity path verified working in production, event-injection
path not yet exercised with real data (see Gotchas).

It replaces two retired mechanisms: the NATS bridge's active-wake routing table, and the
`execute-triggered-intents.sh` cron job.

## Code

- **Local:** `~/.openclaw/workspace-pax/projects/intent-context/`
  (moved here 2026-07-19; was `~/.openclaw/plugins-dev/intent-context/`)
- **Remote:** none
- **Language:** TypeScript (compiled to `dist/` via `tsc`)
- **Build:** `npm install && npm test && npm run plugin:build` — see Gotchas, this is
  **not** the standard OpenClaw plugin build
- **Config:** `plugins.entries.intent-context.config` in `~/.openclaw/openclaw.json`
  (edit ONLY via `~/.openclaw/skills/openclaw-config-safe/openclaw-safe-set`)
- **Manifest:** `openclaw.plugin.json` — hand-authored, NOT generated
- **Tests:** `src/index.test.ts`, 15 vitest tests across 4 describe blocks
  (`subjectMatchesDomain`, `buildInjectionForAgent`, `runNotifyExecutor`, `resolvePaths`)

## Architecture

Uses raw `definePluginEntry` (not `defineToolPlugin`) — this single choice drives most of
the build gotchas below.

**Data sources** (all under `~/.openclaw/intents/`, configurable via `intentsDir`):

| File | Written by | Surfaces as |
|---|---|---|
| `pending.json` | intent system | `WATCHING FOR` + `ACTION NEEDED` |
| `recent-events.jsonl` | nats-bridge `eventlog.go` | `RECENT EVENTS` |
| `recent-activity.jsonl` | `log_activity` tool | `RECENT ACTIVITY` |

**Per-agent filtering** is entirely read-time, from `config.agents[agentId]`:

- `watchedTriggerTypes` → pending intents where `status="pending"` and `trigger.type` matches
- `actorFor` → pending intents where `status="triggered"` and **`notify_agent`** matches
- `eventDomains` → events matching a NATS-style subject pattern (`*` = one token, `>` = rest)
- `ambientScope` → `"all"` or a list of agent ids to see activity from

If an agent has no entry in `config.agents`, the hook returns early and injects nothing.

**Notify executor** (`gateway_start` timer, default 60s): scans `pending.json` and
`archive.json` for `status="triggered"` + `action.type="notify"`, renders
`action.message_template` against `trigger_data` (`{{key}}` substitution, missing → `"N/A"`),
shells out to `openclaw message send`, then sets `status="completed"` in place. It does
**not** move intents from pending to archive. `agent_task`-type intents are deliberately
left alone — those need judgment and surface via injection instead.

The same timer also prunes both `.jsonl` logs to a hardcoded 48h retention.

Concurrency is guarded by a `mkdir`-based lock at `~/.openclaw/intents/.lock`.

## Decisions

| Date | Decision | Why |
|------|----------|-----|
| 2026-07-17 | Passive context injection, never active wake | Carl: "it doesn't have to be a guaranteed delivery, just inject what's happened recently across agents into an agent's context." The routing-table mechanism was designed for the wrong shape of problem. |
| 2026-07-17 | Bridge only appends to a shared log; no agent targeting | Old routing table only ever pointed at Scout (3 routes) — Silas/Pax/Roger had zero wiring. Relevance now lives per-agent in plugin config, so bridge and agents need no coordination. |
| 2026-07-18 | Mechanical `notify` execution moves into plugin code | The `execute-triggered-intents.sh` cron ran a full LLM-backed agent turn every 60s to execute 100%-deterministic bash+jq. Pure waste — probably why it was silently disabled 2026-07-08 and never missed. |
| 2026-07-18 | `agent_task` intents NOT auto-executed | They need real judgment; they surface via injection to the actor agent instead. |
| 2026-07-19 | Project moved into `workspace-pax/projects/` and handed to Pax | Brings it under normal project conventions and Pax ownership. |

## Critical Gotchas

- **`gateway_start` DOES NOT FIRE ON HOT-RELOAD (verbatim, per Carl):** gateway_start does
  NOT fire when this plugin is hot-enabled/hot-reloaded via a config change alone (e.g.
  adding it to plugins.allow, or most plugins.entries.<id>.config edits). Confirmed by
  direct testing 2026-07-18: a triggered notify intent sat unprocessed for 20+ minutes
  after the plugin showed as "enabled" and its hooks/tools were already working, until an
  actual `openclaw gateway restart` was run — then it processed within one interval tick.
  Always do a full gateway restart (not just rely on openclaw-safe-set's automatic
  restart-if-needed logic, which sometimes reports "hot-reloadable, no restart needed" for
  changes that actually do need one to re-fire gateway_start) after touching this plugin's
  code or config. If in doubt, restart anyway.

- **The 48h log pruning rides the same timer.** Because `pruneLogFile` is registered inside
  the `gateway_start` handler alongside the notify executor, the gotcha above has a second
  consequence nobody documented: after a hot-reload, `recent-events.jsonl` and
  `recent-activity.jsonl` grow unbounded until a real restart. Retention is a hardcoded
  constant (`DEFAULT_LOG_RETENTION_MS`), not configurable.

- **Non-standard build — `openclaw plugins build --entry` does not work.** `npm run
  plugin:build` runs `tsc` only. The `openclaw plugins build/validate --entry` commands
  only support `defineToolPlugin`-shaped entries and error with "plugin entry does not
  expose defineToolPlugin metadata" on this one. `openclaw.plugin.json` is hand-authored:
  **if you change a tool's parameters or the `configSchema`, you must hand-edit
  `openclaw.plugin.json` to match.** Nothing validates the two are in sync.

- **`actorFor` matches the intent's `notify_agent` field, not a field named `actorFor`.**
  Non-obvious: config `actorFor: ["pax"]` selects triggered intents whose `notify_agent`
  is `"pax"`. Renaming or omitting `notify_agent` upstream silently disables ACTION NEEDED.

- **All file reads fail silently to empty.** `readJsonArray` and `readJsonLines` swallow
  every error and return `[]`. A corrupt or truncated `pending.json` produces *no injection
  and no error* — indistinguishable from "nothing to report." Verify the file directly
  before concluding the plugin is working.

- **A stale lock directory deadlocks the notify executor.** The lock is `fs.mkdir` on
  `~/.openclaw/intents/.lock`, released by `rmdir`. If the gateway is killed mid-execution
  the directory survives, and every subsequent tick throws after 5×1s retries. The error
  goes to `console.error` only — no alert, no intent ever sends. See Runbook.

- **Two hardcoded values with no config escape hatch:** the `openclaw` binary path
  (`/opt/homebrew/bin/openclaw`, resolved absolutely to dodge the gateway's PATH) and the
  fallback notify channel (`bluebubbles`) when `action.channel` is unset.

- **`recentActivityWindowMs` default is 6h, not 24h.** Live config overrides it to
  86400000 (24h). `recentEventsWindowMs` (24h) and `notifyExecutorIntervalMs` (60000) are
  unset and using defaults.

- **`README.md` is stale boilerplate.** It calls this a "Simple OpenClaw tool plugin" (it is
  explicitly not a tool plugin) and tells you to run `npm run plugin:validate`, which is not
  a script in `package.json`. Do not follow it; follow the Build line above.

## Task Backlog

See workboard cards: `workboard_list(boardId="intent-context")`. See the
`workboard-usage` skill for conventions.

## Shipped

| ID | What | Date |
|----|------|------|
| — | Initial plugin: `before_prompt_build` injection, notify executor, `log_activity` tool (pre-Pax, built by Carl) | 2026-07-18 |
| IC-C001 | Project adopted by Pax: INDEX.md + wiki entity created, ownership established | 2026-07-19 |

## Runbook

**Notify intents are triggered but never send:**
1. Check for a stale lock: `ls -d ~/.openclaw/intents/.lock`
2. If present and the gateway is healthy, remove it: `rmdir ~/.openclaw/intents/.lock`
3. Check gateway logs for `[intent-context] notify executor error`
4. If the plugin was recently hot-reloaded, the timer never started —
   `openclaw gateway restart` (see first gotcha)

**Injection isn't appearing in an agent's turn:**
1. `openclaw plugins inspect intent-context --runtime` — confirm Status `loaded`, hooks
   `before_prompt_build`/`gateway_start`/`gateway_stop`, tool `log_activity`
2. Confirm the agent id has an entry under `plugins.entries.intent-context.config.agents`
   — no entry means the hook returns early and injects nothing
3. Validate the source files parse: `python3 -m json.tool ~/.openclaw/intents/pending.json`
   (silent-empty failure mode above)
4. Check timestamps are within window — entries older than the window are filtered out

**RECENT EVENTS is empty:**
1. Confirm the bridge is alive: `launchctl list | grep nats-bridge`
2. Check `~/.openclaw/logs/nats-bridge.stderr.log` for reconciler heartbeats
3. Check the stream actually has traffic:
   `nats --server nats://localhost:4222 stream info OPENCLAW_EVENTS`
   — as of 2026-07-19 the stream held 1 message total, so an empty log is expected,
   not necessarily a fault

**After ANY code or config change:**
1. `npm test` (15 tests must pass)
2. `npm run plugin:build`
3. Hand-check `openclaw.plugin.json` still matches `ConfigSchema` / tool params
4. `openclaw gateway restart` — always, not a config nudge
5. `openclaw plugins inspect intent-context --runtime` to confirm
