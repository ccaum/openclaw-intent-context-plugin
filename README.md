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
- `status` — `"triggered" (condition met, wake target agent) or `"completed"` (action taken, close out)
- `message` — what you saw and why it matched (required when triggering)
- `trigger_data` — optional structured data for the target agent

When status is `"triggered"`, the plugin stores the message and data on the intent and wakes the target agent via `openclaw system event`. The target agent sees the trigger in its ACTION NEEDED block on its next turn.

### list_trigger_types

List the valid trigger types that can be used when creating intents or configuring watchedTriggerTypes. Returns each type with its description.

```
list_trigger_types()
```

Returns an object with `triggerTypes` — a map of type strings to human-readable descriptions.

### intent_create

Create a new pending intent for the system to watch for. The trigger type must be a registered type (use `list_trigger_types` to see valid types). The `notify_agent` is the agent that should be woken when the condition is met.

```
intent_create(trigger_type: string, description: string, notify_agent: string, trigger_data?: object, action_type?: "notify" | "agent_task", action_message_template?: string)
```

- `trigger_type` — must be a registered type (see `list_trigger_types`)
- `description` — human-readable description of what condition to watch for
- `notify_agent` — the agent id that should be notified when triggered
- `trigger_data` — optional structured data describing what to watch for
- `action_type` — `"notify"` (default) just wakes the target agent. `"agent_task"` surfaces it for the agent to decide
- `action_message_template` — optional message template with `{{key}}` placeholders filled from `trigger_data`
- `expires_at` — optional ISO 8601 timestamp. Defaults to 24 hours from creation. Intents that expire before being triggered are automatically pruned.

If the trigger type is not in the registry, the tool returns an error listing all valid types.

## Context Injection Blocks

Agents may see these blocks at the top of their turn. They are background context, not user requests.

- **WATCHING FOR** — pending intents matching the agent's configured `watchedTriggerTypes`. Conditions the agent should watch for during its normal work.
- **ACTION NEEDED** — triggered intents assigned to the agent. Another agent recognized a condition and triggered an intent for this agent to act on. Includes the triggering agent's message and any structured data.
- **RECENT ACTIVITY** — recent `log_activity` entries from other agents. Background awareness of what's happening across the system.

## Examples

### Development Orchestration

An orchestrator agent coordinates a team of development agents: a coder, a tester, and a deployer. The coder is building a feature, the tester needs to test it when it's ready, and the orchestrator needs to know when it ships.

1. The orchestrator creates an intent: watch for `build_complete` events, notify the orchestrator. The coder has `watchedTriggerTypes: ["build_complete"]` in its config.
2. The coder finishes the build and calls `log_activity("Feature X build complete, commit abc123, all tests pass")`.
3. The orchestrator sees this in RECENT ACTIVITY on its next turn — no message needed, the coder didn't have to know the orchestrator cares about this.
4. The coder also sees the WATCHING FOR intent in its context (it was there the whole time), recognizes the build is complete, and calls `intent_update(id, "triggered", message="Build abc123 passed all 48 tests, ready for QA")`.
5. The plugin wakes the orchestrator with a system event. The orchestrator sees ACTION NEEDED on its next turn with the coder's message.
6. The orchestrator dispatches the tester to verify the build, and when the tester reports back, the orchestrator marks the intent complete with `intent_update(id, "completed")`.

Throughout this flow, no agent actively messaged another. The coder logged activity passively. The orchestrator saw it without being told. The intent handoff went through the plugin, not through direct messaging.

### Watching for a Transaction

A user tells their assistant agent: "Let me know when the refund from Acme hits my account." A separate transaction monitoring agent processes bank transactions as part of its normal routine.

1. The assistant creates an intent: watch for a transaction matching "refund from Acme", notify the assistant. The monitoring agent has `watchedTriggerTypes: ["transaction"]` in its config.
2. The monitoring agent is processing the day's transactions as part of its normal work. It sees WATCHING FOR in its context: "refund from Acme over $200".
3. The monitoring agent notices a $500 refund from Acme in the transaction feed. It calls `intent_update(id, "triggered", message="Refund of $500 from Acme posted today", trigger_data={"amount": 500, "merchant": "Acme", "date": "2026-07-25"})`.
4. The plugin wakes the assistant with a system event. The assistant sees ACTION NEEDED on its next turn: "From monitoring: Refund of $500 from Acme posted. Data: {amount: 500, merchant: Acme, date: 2026-07-25}."
5. The assistant notifies the user and calls `intent_update(id, "completed")`.

The monitoring agent didn't need to know how to reach the assistant. The assistant didn't need to be running when the refund posted. The intent carried the context — what to watch for, who to notify — through the full chain.

### External System Integration

A home automation pipeline detects someone arriving home. It doesn't run as an OpenClaw agent, but it can still surface events to agents that do.

1. The pipeline detects a vehicle in the driveway and calls `/tools/invoke` on the gateway:
   ```bash
   curl -sS http://127.0.0.1:18789/tools/invoke \
     -H "Authorization: Bearer $GATEWAY_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"tool":"log_activity","args":{"text":"Driveway: vehicle arrived, someone home","agent":"motion-pipeline"}}'
   ```
2. A home awareness agent sees this in RECENT ACTIVITY on its next turn. It didn't need to be running when the event happened — it sees it whenever its next turn occurs.
3. The home awareness agent can then take action: log the arrival, check if any home automation intents match, or notify the user if configured to do so.

The pipeline doesn't need to know which agent cares about driveway events. It just logs activity. Any agent with `ambientScope` including `"motion-pipeline"` sees it.

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
    "triggerTypes": {
      "transaction": "Bank or payment transactions — deposits, refunds, charges",
      "home_event": "Home automation events — arrivals, departures, device state changes",
      "email": "Inbound email matching specific criteria"
    },
    "agents": {
      "assistant": {
        "actorFor": ["assistant"],
        "ambientScope": ["monitor", "assistant"]
      },
      "monitor": {
        "watchedTriggerTypes": ["transaction"]
      },
      "home": {
        "watchedTriggerTypes": ["home_event"]
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
| `triggerTypes` | — | Registry of valid trigger types. Keys are type strings, values are descriptions of when to use them. Required for intent creation and watchedTriggerTypes validation. |
| `agents` | (required) | Per-agent awareness config, keyed by agentId |
| `agents.<id>.watchedTriggerTypes` | — | Trigger types to watch for. Must be registered in triggerTypes. |
| `agents.<id>.actorFor` | — | `notify_agent` values this agent acts on |
| `agents.<id>.ambientScope` | — | `"all"` or array of agent ids to see activity from |
| `recentActivityWindowMs` | `21600000` (6h) | How far back to surface activity entries |
| `logRetentionMs` | `172800000` (48h) | Retention for pruning the activity log |

### How actorFor works

When an intent is triggered, it has a `notify_agent` field — the agent that should act on it. `actorFor` in an agent's config says "I handle triggered intents where `notify_agent` matches these values." If an agent has `actorFor: ["assistant"]`, any triggered intent with `notify_agent: "assistant"` shows up in that agent's ACTION NEEDED block. It's the routing for triggered intents — `watchedTriggerTypes` routes pending intents to watchers, `actorFor` routes triggered intents to actors.

## Installation

1. Clone or copy this project to a directory
2. Run `npm install && npm run plugin:build`
3. Add to `~/.openclaw/openclaw.json` under `plugins.entries.intent-context`
4. `openclaw gateway restart` (always do a full restart — `gateway_start` does not fire on hot-reload)

## After Any Change

A full `openclaw gateway restart` is required for the plugin to reload. There is no hot-reload.

## License

MIT