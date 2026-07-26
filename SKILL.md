---
name: intent-context
description: "Create, check, and manage deferred intents — actions triggered by future events (email, transactions, home events, device presence, calendar, or custom conditions). Use when a user says 'let me know when...', 'remind me if...', 'when X happens do Y', or when processing events that might match a pending intent."
---

# Intent System

Intents are deferred actions: "when [trigger], do [action]." They live in a shared file so any agent can create them and any event-processing agent can match them. The intent-context plugin surfaces pending intents to agents via WATCHING FOR injection and delivers triggered intents via ACTION NEEDED injection.

## When to Use

### Creating intents
The user says something that implies a future trigger:
- "Let me know when the Costco refund hits"
- "When I get the Amazon shipping email, forward tracking to Laura"
- "Remind me to ask about X at my next appointment with Dr. Kim"
- "Install the app when I get home"

### Checking intents
You're processing an event (email arrived, transaction synced, person detected, device came online) and should check if any pending intent matches. The intent-context plugin injects WATCHING FOR into your context automatically — you don't need to read pending.json manually. Just check if the event you're processing matches any of the watching-for intents.

## Tools

### intent_create

Create a new pending intent. The trigger type must be registered in the plugin's `triggerTypes` config.

```
intent_create(trigger_type: string, description: string, notify_agent: string, trigger_data?: object, action_type?: "notify" | "agent_task", action_message_template?: string)
```

- `trigger_type` — must be a registered type (use `list_trigger_types` to see valid types)
- `description` — human-readable description of what condition to watch for
- `notify_agent` — the agent id that should be notified when triggered
- `trigger_data` — optional structured data describing what to watch for (e.g. `{"merchant": "Acme", "min_amount": 200}`)
- `action_type` — `"notify"` (default) wakes the target agent. `"agent_task"` surfaces it for the agent to decide
- `action_message_template` — optional message template with `{{key}}` placeholders filled from trigger_data

If the trigger type is not in the registry, the tool returns an error listing all valid types.

### intent_update

Update the lifecycle of an intent. Trigger an intent when you see a condition match, or complete it when you've acted on it.

```
intent_update(id: string, status: "triggered" | "completed", message?: string, trigger_data?: object)
```

- `id` — the intent ID to update
- `status` — `"triggered"` (condition met, wake target agent) or `"completed"` (action taken, close out)
- `message` — what you saw and why it matched (required when triggering)
- `trigger_data` — optional structured data for the target agent

When status is `"triggered"`, the plugin stores your message and data on the intent and wakes the target agent with a system event. The target agent sees the trigger in its ACTION NEEDED block on its next turn.

### list_trigger_types

List the valid trigger types that can be used when creating intents.

```
list_trigger_types()
```

Returns a map of trigger type strings to their descriptions. Use this before calling `intent_create` if you're not sure what trigger type to use.

### log_activity

Append a short note about what you're doing to the shared activity log. Other agents see it in their RECENT ACTIVITY block on their next turn. Does not notify or wake anyone.

```
log_activity(text: string, agent?: string)
```

Use this when you complete a significant task or observe something noteworthy. Don't use it for routine work or urgent notifications (use `intent_update` or direct messaging instead).

## Context Injection Blocks

You may see these blocks at the top of your turn. They are background context, not user requests.

- **WATCHING FOR** — pending intents matching your configured `watchedTriggerTypes`. When you see something in your work that matches a watching-for intent, trigger it using `intent_update`.
- **ACTION NEEDED** — triggered intents assigned to you. Another agent recognized a condition and triggered an intent for you to act on. Read the message from the triggering agent, check the data, and take whatever action the intent requires. When you're done, call `intent_update` with status="completed".
- **RECENT ACTIVITY** — recent `log_activity` entries from other agents. Background awareness of what's happening across the system.

## Trigger Types

Trigger types are defined in the intent-context plugin's `triggerTypes` config. Common types:

**transaction** — Bank or payment transactions
```json
{"type": "transaction", "conditions": {"merchant": "Costco", "direction": "credit"}}
```

**email** — Inbound email matching criteria
```json
{"type": "email", "conditions": {"sender_contains": "amazon", "subject_contains": "shipped"}}
```

**home_event** — Home automation events
```json
{"type": "home_event", "conditions": {"person": "Carl", "event": "arrived"}}
```

**device_presence** — Device state changes
```json
{"type": "device_presence", "conditions": {"device": "Carl's iPhone", "state": "available"}}
```

**calendar** — Calendar events
```json
{"type": "calendar", "conditions": {"title_contains": "Dr. Kim"}}
```

**custom** — Any condition, evaluated by LLM
```json
{"type": "custom", "conditions": {"description": "Laura texts about dinner plans"}}
```

For custom triggers: pass the event description + the condition to the LLM and ask "Does this event match this condition? Yes or no." Only trigger on confident yes.

Use `list_trigger_types` to see what's registered in your installation.

## Workflow

### Creating an intent

1. Call `list_trigger_types` if you're not sure what trigger type to use
2. Call `intent_create` with the trigger type, description, and notify_agent
3. Confirm to the user: "I'll watch for that and let you know."

### Matching an intent (event processing)

When you process an event that could match an intent:

1. Check the WATCHING FOR block in your context for pending intents
2. For each matching type, evaluate conditions against the current event
3. If match found, call `intent_update(id, "triggered", message="what you saw", trigger_data={...})`
4. The plugin wakes the target agent — you don't need to message them yourself

### Acting on a triggered intent

When you see ACTION NEEDED in your context:

1. Read the triggering agent's message and trigger_data
2. Take whatever action the intent requires (notify the user, forward content, execute a task)
3. Call `intent_update(id, "completed")` to close it out

## File Locations

```
~/.openclaw/intents/
├── pending.json          # Active intents (managed by tools, don't edit manually)
├── archive.json          # Completed/expired (append-only)
└── recent-activity.jsonl # Activity log (managed by log_activity tool)
```

Do not read or write these files directly. Use the tools (`intent_create`, `intent_update`, `log_activity`).

## Examples

### Creating: "Let me know when the Costco refund hits"

Call `intent_create`:
- trigger_type: "transaction"
- description: "Notify Carl when Costco refund posts"
- notify_agent: "silas" (your agent id)
- trigger_data: {"merchant": "Costco", "direction": "credit"}
- action_message_template: "Your Costco refund just posted: {{amount}}"

Confirm to the user: "I'll watch for that and let you know."

### Matching: Finance agent sees a Costco credit

The finance agent sees WATCHING FOR in its context: "Notify Carl when Costco refund posts." While processing transactions, it spots a Costco credit. It calls `intent_update(id, "triggered", message="Costco refund of $47.23 posted", trigger_data={"amount": "$47.23", "date": "2026-04-05"})`.

The plugin wakes the assistant agent. The assistant sees ACTION NEEDED with the finance agent's message, notifies the user, and calls `intent_update(id, "completed")`.