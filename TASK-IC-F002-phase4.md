# IC-F002 Phase 4 — Add Expiration to intent_create

## Objective

Add an optional `expires_at` parameter to the `intent_create` tool. Default expiration is 24 hours from creation. Also add pruning of expired intents to the existing `gateway_start` timer.

## Change 1: Add expires_at to intent_create

In `src/index.ts`, update the `intent_create` tool parameters:

```typescript
expires_at: Type.Optional(Type.String({
  description: "ISO 8601 timestamp when this intent should expire if never triggered. Defaults to 24 hours from now. Use this for time-sensitive watch conditions.",
})),
```

In the `execute` function, calculate the expiration:

```typescript
// Default: 24 hours from now
const expiresAt = params.expires_at || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
```

Add `expires_at: expiresAt` to the intent object that gets written to `pending.json`.

## Change 2: Prune Expired Intents

In the `gateway_start` handler, alongside the existing `pruneLogFile` call, add a `pruneExpiredIntents` function:

```typescript
async function pruneExpiredIntents(paths: ResolvedPaths): Promise<void> {
  const now = new Date().toISOString();
  const pending = await readJsonArray(paths.pendingPath);
  const active = pending.filter((intent: any) => {
    if (intent.expires_at && intent.status === "pending" && now > intent.expires_at) {
      return false; // expired
    }
    return true;
  });
  if (active.length !== pending.length) {
    await fs.writeFile(paths.pendingPath, JSON.stringify(active, null, 2));
  }
}
```

Call `pruneExpiredIntents(paths)` in the `gateway_start` timer alongside `pruneLogFile(paths)`.

## Change 3: Update Tests

Add tests in `src/index.test.ts`:

1. `intent_create` sets `expires_at` to 24h from now by default — verify the field exists and is approximately 24h out
2. `intent_create` with explicit `expires_at` uses the provided value
3. `pruneExpiredIntents` removes expired pending intents but keeps active ones and triggered ones

## Change 4: Update README

In the `intent_create` tool section, add:

- `expires_at` — optional ISO 8601 timestamp. Defaults to 24 hours from creation. Intents that expire before being triggered are automatically pruned.

## Change 5: Update SKILL.md

In the `intent_create` section of the packaged SKILL.md, add `expires_at` to the parameter list and mention the 24h default.

## File Boundaries
- Edit: `src/index.ts`, `src/index.test.ts`, `README.md`, `SKILL.md`
- Do NOT edit any other files

## Build and Test
1. `npm install`
2. `npm test` — all tests must pass
3. `npm run plugin:build` — must compile cleanly

## Commit
```bash
git add src/index.ts src/index.test.ts README.md SKILL.md
git commit -m "feat(IC-F002): add expires_at to intent_create (24h default) with auto-pruning"
```