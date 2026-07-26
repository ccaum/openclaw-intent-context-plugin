# OpenClaw Intent Context Plugin

The Intent Context plugin gives OpenClaw agents passive awareness of what other agents are doing and lets them watch for future events as part of their normal operation. It injects recent activity from other agents and pending conditions an agent should be watching for into each agent's turn as it happens, so agents can coordinate and react without being explicitly told. When an agent recognizes a watched condition and triggers an intent, the plugin wakes the target agent so it can act on it. No agent is ever actively woken unnecessarily — everything surfaces on whatever turn happens next.

Without this plugin, OpenClaw agents operate in isolation. An orchestration agent can't see when a coder finishes a build, a QA agent passes or fails a test, or an operations agent deploys a fix — unless someone explicitly sends a message each time. But agents rarely know what's worth notifying another agent about, so coordination breaks down or requires manual handoffs. Personal assistant agents face the same problem: they can't decide when to mention relevant activity from other agents to their user without being prompted, because they don't have that activity in context. Beyond cross-agent awareness, asking an agent to watch for a future event and react to it required a cron job to continuously poll for the condition. You couldn't tell your assistant agent "let me know when the refund hits my bank account" and have a monitoring agent watch for that condition as part of its normal routine and take action when it sees the match — because there was no mechanism to surface the watch condition to the monitoring agent in the first place, and no way for the monitoring agent to hand the result back to the assistant without direct messaging.

The plugin solves both problems through passive context injection and intent lifecycle tools. A `before_prompt_build` hook reads recent activity from other agents and pending watch conditions from shared log files and injects them into whichever agent turn is already happening — so an orchestration agent sees when the coder shipped, a personal assistant knows what other agents have been doing, and a monitoring agent sees what conditions it should be watching for in its normal flow. Any agent or external system can append to the activity log via a simple HTTP call, so home automation pipelines, transaction monitors, and email processors can surface events the same way agents do. When an agent recognizes a condition and triggers an intent using the `intent_update` tool, the plugin wakes the target agent with a system event so it sees the trigger on its next turn — the monitoring agent doesn't need to know how to reach the assistant, and the assistant doesn't need to be running when the condition is met. The target agent reads the triggering agent's message, takes action, and marks the intent complete.

## Tools

### log_activity

Append a short note about what you're doing to the shared activity log. Other agents see it in their RECENT ACTIVITY block on their next turn. Does not notify or wake anyone.

```
log_activity(text: string, agent?: string)
```

- `text` — short description of what happened
- `agent` — optional identifier for external systems (defaults to the calling agent's id)

External systems can call it via the Gateway's `/tools/invoke` HTTP endpoint:

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tool":"log_activity","args":{"text":"Driveway: vehicle arrived","agent":"marlin"}}'
```

### intent_update

Update the lifecycle of an intent. Trigger an intent when you see a condition match, or complete it when you've acted on it.

```
intent_update(id: string, status: "triggered" | "completed", message?: string, trigger_data?: object)
```

- `id` — the intent ID to update
- `status` — `"triggered"` (condition met, wake target agent) or `"completed"` (action taken, close out)
- `message` — what you saw and why it matched (required when triggering)
- `trigger_data` — optional structured data for the target agent

When status is `"triggered"`, the plugin stores the message and data on the intent and wakes the target agent via `openclaw system event`. The target agent sees the trigger in its ACTION NEEDED block on its next turn.

## Context Injection Blocks

Agents may see these blocks at the top of their turn. They are background context, not user requests.

- **WATCHING FOR** — pending intents matching the agent's configured `watchedTriggerTypes`. Conditions the agent should watch for during its normal work.
- **ACTION NEEDED** — triggered intents assigned to the agent. Another agent recognized a condition and triggered an intent for this agent to act on. Includes the triggering agent's message and any structured data.
- **RECENT ACTIVITY** — recent `log_activity` entries from other agents. Background awareness of what's happening across the system.

## Architecture

**Passive injection, never active wake.** The plugin reads local files and injects context into turns that are already happening. The only active wake is when an intent is triggered — the plugin enqueues a system event for the target agent so it sees ACTION NEEDED on its next turn.

**Data sources** (all under `~/.openclaw/intents/`):

| File | Written by | Surfaces as |
|------|-----------|-------------|
| `pending.json` | intent system, `intent_update` tool | WATCHING FOR + ACTION NEEDED |
| `recent-activity.jsonl` | `log_activity` tool | RECENT ACTIVITY |

**Per-agent filtering** is entirely read-time, from `config.agents[agentId]`:

- `watchedTriggerTypes` — pending intents where `status="pending"` and `trigger.type` matches
- `actorFor` — pending intents where `status="triggered"` and `notify_agent` matches
- `ambientScope` — `"all"` or a list of agent ids to see activity from

If an agent has no entry in `config.agents`, the hook returns early and injects nothing.

A `gateway_start` timer prunes `recent-activity.jsonl` to a configurable retention window.

## Build

```bash
npm install
npm test
npm run plugin:build
```

`npm run plugin:build` runs `tsc` only (no bundler step).

### What does NOT work

- `openclaw plugins build --entry …` and `openclaw plugins validate --entry …` do not work for this plugin. Do not use them.
- `openclaw.plugin.json` is **hand-authored** — it is not generated by a build step. Edit it directly if you change the config schema or tool parameters.

## Configuration

Add to `~/.openclaw/openclaw.json` under `plugins.entries.intent-context`:

```json
{
  "config": {
    "intentsDir": "~/.openclaw/intents",
    "agents": {
      "pax": {
        "actorFor": ["pax"],
        "ambientScope": ["scout", "roger", "pax"]
      },
      "scout": {
        "watchedTriggerTypes": ["home_event", "device_presence"]
      }
    },
    "recentActivityWindowMs": 86400000,
    "logRetentionMs": 172800000
  }
}
```

### Config fields

| Field | Default | Description |
|-------|---------|-------------|
| `intentsDir` | `~/.openclaw/intents` | Path to the shared intents store |
| `agents` | (required) | Per-agent awareness config, keyed by agentId |
| `agents.<id>.watchedTriggerTypes` | — | Trigger types to watch for in pending intents |
| `agents.<id>.actorFor` | — | `notify_agent` values this agent acts on |
| `agents.<id>.ambientScope` | — | `"all"` or array of agent ids to see activity from |
| `recentActivityWindowMs` | `21600000` (6h) | How far back to surface activity entries |
| `logRetentionMs` | `172800000` (48h) | Retention for pruning the activity log |

## Installation

1. Clone or copy this project to a directory
2. Run `npm install && npm run plugin:build`
3. Add to `~/.openclaw/openclaw.json` under `plugins.entries.intent-context`
4. `openclaw gateway restart` (always do a full restart — `gateway_start` does not fire on hot-reload)

## After Any Change

A full `openclaw gateway restart` is required for the plugin to reload. There is no hot-reload.

## License

MIT