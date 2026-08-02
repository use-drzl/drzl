---
'@drzl/analyzer': minor
'@drzl/cli': minor
---

**The analyzer no longer reports an unknown dialect as SQLite.** It did, with no diagnostic at
all. Unrecognised columns returned `dbType: 'UNKNOWN'`, the `/At$/` heuristic then rewrote
`createdAt` to `INTEGER`, and that fabricated INTEGER satisfied a "does anything look like a
SQLite storage class" fallback. Verified before the fix:

    { "dialect": "sqlite", "issues": 0, "cols": ["id=UNKNOWN", "createdAt=INTEGER"] }

Detection is keyed off `Symbol.for('drizzle:entityKind')` now, the static Drizzle stamps on every
column class and uses internally for this. `constructor.name` remains only as a fallback, because
it does not survive minification: a bundled schema presents its columns as `a`, `b`, `c`.

`mssql` and `cockroach` are recognised, both added in Drizzle v1. Where nothing matches the
result is `unknown` plus a `DRZL_ANL_DIALECT` warning, rather than a confident wrong answer.

**Tables can now be filtered**, with top-level `include` and `exclude`:

```ts
export default defineConfig({
  schema: 'src/db/schema.ts',
  exclude: ['session', 'account', 'verification', '__drizzle_*'],
  generators: [{ kind: 'orpc' }],
});
```

There was no way to say this, and every generator loops over every table it finds, so DRZL
emitted unauthenticated CRUD over whatever shared the schema file. For a migrations table that is
noise. For an auth table it is a leak: Better Auth puts `user`, `session`, `account` and
`verification` alongside your own, and `account` holds `accessToken`, `refreshToken`, `idToken`
and `password`.

Matching is anchored, on the database table name, with `*` as the only metacharacter, so
`exclude: ['user']` does not also drop `users`. `exclude` wins over `include`.

Deliberately explicit rather than detecting any particular library. Better Auth's model names are
all overridable, so a built-in list would miss a renamed table and, worse, silently skip an
ordinary table called `user`, which is usually the application's own primary entity.
