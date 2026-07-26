# IC-F002 Phase 5 — Fix trigger field mismatch

## Problem

`intent_create` writes `trigger.data` but the injection code in `buildInjectionForAgent` reads `trigger.conditions`. New intents created via the tool show empty conditions in WATCHING FOR.

Old manually-created intents use `trigger.conditions`. The tool should match.

## Fix

In `src/index.ts`, in the `intent_create` tool's `execute` function, change:

```typescript
trigger: {
  type: params.trigger_type,
  data: params.trigger_data || {},
},
```

to:

```typescript
trigger: {
  type: params.trigger_type,
  conditions: params.trigger_data || {},
},
```

That's it. One field name change.

## Test

Add a test verifying that `intent_create` writes `trigger.conditions` (not `trigger.data`).

## Build

1. `npm test` — all tests pass
2. `npm run plugin:build` — clean compile

## Commit

```bash
git add src/index.ts src/index.test.ts
git commit -m "fix(IC-F002): intent_create writes trigger.conditions not trigger.data"
```