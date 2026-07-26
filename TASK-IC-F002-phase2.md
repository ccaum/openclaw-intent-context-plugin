# IC-F002 Phase 2 — Kill Executor, Add intent_update Tool, Package Skill

## Objective

Three changes to the intent-context plugin at `~/.openclaw/workspace-pax/projects/intent-context/`:

1. Remove the notify executor entirely
2. Add an `intent_update` tool for intent lifecycle management
3. Write a SKILL.md packaged with the plugin

## Change 1: Remove the Notify Executor

Remove all code related to the notify executor from `src/index.ts`:

- Remove `runNotifyExecutor` function entirely
- Remove the `runNotifyExecutor` call from the `gateway_start` timer
- Remove `withIntentsLock`, `tryAcquireLock`, `releaseLock`, and all lock-related code
- Remove `openclawBin` from `ConfigSchema`, `resolvePaths`, and defaults
- Remove `fallbackNotifyChannel` from `ConfigSchema`, `resolvePaths`, and defaults
- Remove `notifyExecutorIntervalMs` from `ConfigSchema` and defaults
- Remove `DEFAULT_NOTIFY_INTERVAL_MS` constant
- Keep the `pruneLogFile` call for `paths.activityLogPath` — that stays
- Keep the `gateway_start` timer registration but only for pruning

Remove executor-related tests from `src/index.test.ts`:
- Remove the `runNotifyExecutor` describe block entirely
- Remove the `withIntentsLock` describe block entirely
- Keep `buildInjectionForAgent`, `resolvePaths`, and `log_activity` tests

Remove from `openclaw.plugin.json`:
- Remove `notifyExecutorIntervalMs`, `openclawBin`, `fallbackNotifyChannel` from configSchema properties

## Change 2: Add `intent_update` Tool

Add a new `intent_update` tool registration in `src/index.ts` alongside `log_activity`:

```typescript
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
    execute: async (_toolCallId, params) => {
      // Read pending.json
      // Find intent by id
      // If status="triggered":
      //   - Set intent.status = "triggered"
      //   - Set intent.trigger_data = params.trigger_data || {}
      //   - Set intent.trigger_message = params.message
      //   - Set intent.triggered_at = new Date().toISOString()
      //   - Set intent.triggered_by = toolCtx.agentId
      //   - Write pending.json back
      //   - Enqueue system event for intent.notify_agent session:
      //     use child_process execSync to run:
      //     openclaw system event --session-key agent:<notify_agent>:main --text "Intent <id> triggered: <message>"
      //     (wrap in try/catch, log errors but don't fail the tool)
      // If status="completed":
      //   - Set intent.status = "completed"
      //   - Set intent.completed_at = new Date().toISOString()
      //   - Set intent.completed_by = toolCtx.agentId
      //   - Write pending.json back
      //   - No wake needed
      // Return { ok: true, intent: { id, status } }
    }
  }),
  { name: "intent_update" },
);
```

Implementation details:
- Read/write `pending.json` using the same `readJsonArray` / file write pattern already in the codebase
- For the system event wake, shell out to `openclaw system event` — the `openclawBin` path was removed from config, so use `openclaw` from PATH (or `/opt/homebrew/bin/openclaw` as fallback)
- Wrap the wake in try/catch — if it fails, the tool still succeeds (the intent is updated, injection will surface it on the target's next turn anyway)
- Add `intent_update` to the `contracts.tools` array in `openclaw.plugin.json`

## Change 3: Update ACTION NEEDED Injection

In `buildInjectionForAgent`, the ACTION NEEDED section currently surfaces triggered intents where `notify_agent` matches `actorFor`. Update it to also include the trigger message and trigger data:

```
ACTION NEEDED (triggered intents for you to act on):
- [intent-id] <intent.title || intent.description>
  From <triggered_by>: "<trigger_message>"
  Data: <trigger_data>
```

If `trigger_message` is missing (legacy intents), omit the "From" line.

## Change 4: Write SKILL.md

Create `SKILL.md` at the project root (packaged alongside the plugin). This skill teaches agents how to use the plugin's tools and understand the injection blocks.

```markdown
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

## How Agents Coordinate

The intent system lets agents coordinate without direct messaging:

1. Agent A asks the system to watch for a condition (intent created in pending.json)
2. Agent B sees the WATCHING FOR intent in its context during normal work
3. Agent B recognizes the condition and calls `intent_update` to trigger it
4. The plugin wakes Agent A (the notify_agent) with a system event
5. Agent A sees ACTION NEEDED on its next turn with Agent B's message
6. Agent A takes action and calls `intent_update` to complete the intent

This works even when agents can't message each other directly, don't share a channel, or the target agent isn't currently running.
```

## Build and Test

After all changes:
1. `cd ~/.openclaw/workspace-pax/projects/intent-context && npm install`
2. `npm test` — all remaining tests must pass
3. `npm run plugin:build` — must compile cleanly

## File Boundaries
- Edit: `src/index.ts`, `src/index.test.ts`, `openclaw.plugin.json`
- Create: `SKILL.md`
- Do NOT edit any other files

## Commit
```bash
git add src/index.ts src/index.test.ts openclaw.plugin.json SKILL.md
git commit -m "feat(IC-F002): kill notify executor, add intent_update tool, package SKILL.md

- Remove runNotifyExecutor, lock mechanism, notify timer, openclawBin, fallbackNotifyChannel
- Add intent_update tool for intent lifecycle (triggered/completed)
- Triggered intents wake target agent via openclaw system event
- ACTION NEEDED surfaces trigger message and data from triggering agent
- Package SKILL.md teaching agents how to use tools and understand injection"
```

Do NOT use `git add -A` — only add the four files listed.