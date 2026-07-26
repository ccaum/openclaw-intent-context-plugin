---
name: intent-context
description: Cross-agent awareness and intent lifecycle management. Load when you see WATCHING FOR, ACTION NEEDED, or RECENT ACTIVITY in your context, or when you need to log activity or update an intent.
---

# Intent Context

You have access to two tools and three context injection blocks that let you coordinate with other agents without active messaging.

## Context Injection Blocks

You may see these blocks at the top of your turn. They are background context, not user requests.

### WATCHING FOR
Pending intents that match your configured `watchedTriggerTypes`. These are conditions the system has asked you to watch for as part of your normal operation. When you see something in your work that matches a watching-for intent, trigger it using `intent_update`.

Example: You're a transaction monitoring agent. You see "WATCHING FOR: refund from Acme over $200". While processing transactions, you notice a $500 refund from Acme. You call `intent_update` to trigger the intent.

### ACTION NEEDED
Triggered intents assigned to you. Another agent recognized a condition and triggered an intent for you to act on. Read the message from the triggering agent, check the data, and take whatever action the intent requires. When you're done, call `intent_update` with status="completed".

Example: You're a personal assistant. You see "ACTION NEEDED: refund received — From Roger: 'Refund of $500 from Acme posted'. You decide to notify your user and mark the intent complete.

### RECENT ACTIVITY
Recent actions taken by other agents on the system. This is background awareness — not a request for you to do anything. Use it to understand what's happening across the system and decide if any of it is relevant to your user or your current task.

## Tools

### log_activity
```
log_activity(text: string, agent?: string)
```

Append a short note about what you're doing to the shared activity log. Other agents will see it in their RECENT ACTIVITY block on their next turn. This does not notify or wake anyone.

Use this when:
- You complete a significant task (shipped a feature, deployed a fix, finished a review)
- You start work on something other agents should know about
- You observe something noteworthy (a system event, an error, a status change)

Don't use this for:
- Routine work (reading a file, running a test)
- Things only you care about
- Urgent notifications (use intent_update or direct messaging instead)

The optional `agent` parameter is for external systems calling via /tools/invoke that don't have an agent session.

### intent_update
```
intent_update(id: string, status: "triggered" | "completed", message?: string, trigger_data?: object)
```

Update the lifecycle of an intent.

**When to trigger (status="triggered"):**
You see a WATCHING FOR intent in your context and you recognize that the condition has been met in your work. Call `intent_update` with:
- `id` — the intent ID
- `status` — "triggered"
- `message` — what you saw and why it matches (the target agent reads this)
- `trigger_data` — optional structured data the target agent needs

This stores your message on the intent and wakes the target agent so they can act on it.

**When to complete (status="completed"):**
You see an ACTION NEEDED intent in your context, you've taken the action it required, and you want to close it out. Call `intent_update` with:
- `id` — the intent ID
- `status` — "completed"

This marks the intent as done so it stops appearing in ACTION NEEDED.

### intent_create
```
intent_create(trigger_type: string, description: string, notify_agent: string, trigger_data?: object, action_type?: "notify" | "agent_task", action_message_template?: string, expires_at?: string)
```

Create a new pending intent for the system to watch for. The trigger type must be a registered type (use `list_trigger_types` to see valid types).

- `trigger_type` — must be a registered type
- `description` — human-readable description of what condition to watch for
- `notify_agent` — the agent id that should be notified when triggered
- `trigger_data` — optional structured data describing what to watch for
- `action_type` — `"notify"` (default) or `"agent_task"`
- `action_message_template` — optional message template with `{{key}}` placeholders
- `expires_at` — optional ISO 8601 timestamp. Defaults to 24 hours from creation. Intents that expire before being triggered are automatically pruned.

## How Agents Coordinate

The intent system lets agents coordinate without direct messaging:

1. Agent A asks the system to watch for a condition (intent created in pending.json)
2. Agent B sees the WATCHING FOR intent in its context during normal work
3. Agent B recognizes the condition and calls `intent_update` to trigger it
4. The plugin wakes Agent A (the notify_agent) with a system event
5. Agent A sees ACTION NEEDED on its next turn with Agent B's message
6. Agent A takes action and calls `intent_update` to complete the intent

This works even when agents can't message each other directly, don't share a channel, or the target agent isn't currently running.