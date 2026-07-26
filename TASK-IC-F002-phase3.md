# IC-F002 Phase 3 — Trigger Type Registry, intent_create Tool, README

## Objective

Four changes to the intent-context plugin at `~/.openclaw/workspace-pax/projects/intent-context/`:

1. Add `triggerTypes` config section — registry of valid trigger types with descriptions
2. Add `list_trigger_types` tool — lets agents discover valid trigger types
3. Add `intent_create` tool — lets agents create new pending intents, validates trigger type against registry
4. Update README with trigger type registry config, the new tools, and the three examples (already drafted, see current README)

## Change 1: triggerTypes Config Section

Add `triggerTypes` to `ConfigSchema` in `src/index.ts`:

```typescript
triggerTypes: Type.Optional(Type.Record(Type.String(), Type.String({
  description: "Description of when to use this trigger type.",
}), {
  description: "Registry of valid trigger types. Keys are type strings, values are human-readable descriptions. Agents can only watch for registered types and create intents with registered types.",
})),
```

Also add to `openclaw.plugin.json` configSchema properties:

```json
"triggerTypes": {
  "type": "object",
  "description": "Registry of valid trigger types. Keys are type strings, values are human-readable descriptions of when to use that type.",
  "additionalProperties": {
    "type": "string",
    "description": "Description of when to use this trigger type."
  }
}
```

## Change 2: list_trigger_types Tool

Add a `list_trigger_types` tool that returns the registered trigger types and their descriptions:

```typescript
api.registerTool(
  (toolCtx) => ({
    name: "list_trigger_types",
    label: "List Trigger Types",
    description: "List the valid trigger types that can be used when creating intents or configuring watchedTriggerTypes. Returns each type with its description.",
    parameters: Type.Object({}),
    execute: async () => {
      const types = config.triggerTypes || {};
      return {
        triggerTypes: types,
      };
    },
  }),
  { name: "list_trigger_types" },
);
```

Add `list_trigger_types` to `contracts.tools` array in `openclaw.plugin.json`.

## Change 3: intent_create Tool

Add an `intent_create` tool that lets agents create new pending intents. The trigger type MUST be in the registry — if not, the tool returns an error listing the valid types.

```typescript
api.registerTool(
  (toolCtx) => ({
    name: "intent_create",
    label: "Create Intent",
    description: "Create a new pending intent for the system to watch for. The trigger type must be a registered type (use list_trigger_types to see valid types). The notify_agent is the agent that should be woken when the condition is met.",
    parameters: Type.Object({
      trigger_type: Type.String({
        minLength: 1,
        description: "The trigger type for this intent. Must be a registered type (see list_trigger_types).",
      }),
      trigger_data: Type.Optional(Type.Record(Type.String(), Type.Any(), {
        description: "Optional structured data describing what to watch for (e.g. {\"merchant\": \"Acme\", \"min_amount\": 200}).",
      })),
      description: Type.String({
        minLength: 1,
        description: "Human-readable description of what condition to watch for.",
      }),
      notify_agent: Type.String({
        minLength: 1,
        description: "The agent id that should be notified when this intent is triggered.",
      }),
      action_type: Type.Optional(Type.Union([
        Type.Literal("notify"),
        Type.Literal("agent_task"),
      ], {
        description: "What to do when triggered. 'notify' (default) just wakes the target agent. 'agent_task' surfaces it for the agent to decide.",
      })),
      action_message_template: Type.Optional(Type.String({
        description: "Optional message template for the notification. Use {{key}} placeholders that get filled from trigger_data when the intent is triggered.",
      })),
    }),
    execute: async (_toolCallId, params) => {
      // Validate trigger_type against registry
      const validTypes = config.triggerTypes || {};
      if (!(params.trigger_type in validTypes)) {
        const validList = Object.entries(validTypes)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join("\n");
        return {
          ok: false,
          error: `Invalid trigger type: "${params.trigger_type}". Valid types are:\n${validList}`,
        };
      }

      // Read pending.json
      const pending = await readJsonArray(paths.pendingPath);

      // Create new intent
      const intent = {
        id: crypto.randomUUID(),
        status: "pending",
        trigger: {
          type: params.trigger_type,
          data: params.trigger_data || {},
        },
        description: params.description,
        notify_agent: params.notify_agent,
        action: {
          type: params.action_type || "notify",
          message_template: params.action_message_template || params.description,
        },
        created_at: new Date().toISOString(),
        created_by: toolCtx.agentId,
      };

      pending.push(intent);
      await fs.writeFile(paths.pendingPath, JSON.stringify(pending, null, 2));

      return {
        ok: true,
        intent: { id: intent.id, status: "pending" },
      };
    },
  }),
  { name: "intent_create" },
);
```

Add `intent_create` to `contracts.tools` array in `openclaw.plugin.json`.

## Change 4: Update README

The README already has the three examples (development orchestration, financial watch, home automation). Update the Configuration section to include `triggerTypes` in the example config:

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

Add `triggerTypes` to the Config fields table:

| Field | Default | Description |
|-------|---------|-------------|
| `triggerTypes` | — | Registry of valid trigger types. Keys are type strings, values are descriptions of when to use them. Required for intent creation and watchedTriggerTypes validation. |
| `agents.<id>.watchedTriggerTypes` | — | Trigger types to watch for. Must be registered in triggerTypes. |

Add `list_trigger_types` and `intent_create` to the Tools section of the README.

Add a section explaining `actorFor`:

> ### How actorFor works
>
> When an intent is triggered, it has a `notify_agent` field — the agent that should act on it. `actorFor` in an agent's config says "I handle triggered intents where `notify_agent` matches these values." If an agent has `actorFor: ["assistant"]`, any triggered intent with `notify_agent: "assistant"` shows up in that agent's ACTION NEEDED block. It's the routing for triggered intents — `watchedTriggerTypes` routes pending intents to watchers, `actorFor` routes triggered intents to actors.

## Change 5: Validate watchedTriggerTypes against triggerTypes

In `buildInjectionForAgent`, add a check: if `watchedTriggerTypes` contains a type not in `config.triggerTypes`, log a warning to console.error but don't crash. This catches config typos at runtime.

## Build and Test

After all changes:
1. `cd ~/.openclaw/workspace-pax/projects/intent-context && npm install`
2. `npm test` — all tests must pass. Add tests for:
   - `list_trigger_types` returns registered types
   - `intent_create` with valid trigger type succeeds
   - `intent_create` with invalid trigger type returns error with valid types listed
3. `npm run plugin:build` — must compile cleanly

## File Boundaries
- Edit: `src/index.ts`, `src/index.test.ts`, `openclaw.plugin.json`, `README.md`
- Do NOT edit any other files

## Commit
```bash
git add src/index.ts src/index.test.ts openclaw.plugin.json README.md
git commit -m "feat(IC-F002): add trigger type registry, list_trigger_types tool, intent_create tool

- triggerTypes config section registers valid trigger types with descriptions
- list_trigger_types tool lets agents discover valid types
- intent_create tool validates trigger type against registry, returns valid types on failure
- watchedTriggerTypes validated against registry at injection time
- README updated with triggerTypes config, new tools, actorFor explanation"
```

Do NOT use `git add -A` — only add the four files listed.