# IC-F002 Phase 6 — Fix case-insensitive agent lookup

## Problem

The plugin config uses lowercase keys (`postman`, `scout`, `roger`) but agent ids are capitalized (`Postman`, `Scout`, `Roger`). The injection code does `config.agents?.[agentId]` which is case-sensitive — it returns `undefined` for `Postman` because the key is `postman`. This means Postman never sees the WATCHING FOR block.

## Fix

In `src/index.ts`, in the `before_prompt_build` handler, change the agent config lookup to be case-insensitive:

```typescript
const agentConfig = config.agents?.[agentId] ?? config.agents?.[agentId.toLowerCase()];
```

That's it. One line. This way both `Postman` and `postman` match the same config entry.

## Test

Add a test verifying that `buildInjectionForAgent` is called with a capitalized agent id but still finds the config under the lowercase key.

## Build

1. `npm test` — all tests pass
2. `npm run plugin:build` — clean compile

## Commit

```bash
git add src/index.ts src/index.test.ts
git commit -m "fix(IC-F002): case-insensitive agent config lookup in before_prompt_build"
```