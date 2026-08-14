---
'@drzl/cli': minor
---

Recognise authentication tables by their shape, and say so before a generator publishes them.

The leak this addresses is already documented on `tables.exclude`: every generator loops over every
table it finds, Better Auth puts `user`, `session`, `account` and `verification` alongside your own,
and `account` holds `accessToken`, `refreshToken`, `idToken` and `password`. The manual answer
already existed. What was missing was anything that told you, so the exclusion only happened if you
already knew.

That same comment rejects the obvious way to detect them, and the objection is right:

> Auth table names are all renameable, so a built-in list would miss renamed tables and, worse,
> silently skip an ordinary table that happened to be called `user`, which is usually the
> application's main entity.

So the match is on **shape rather than name**, which answers both halves rather than one. A table
renamed to `auth_sessions` still carries `token`, `expiresAt` and a user reference; an ordinary
`users` table carries none of `account`'s provider columns. The conventional name only raises
confidence, never establishes it, and `user` is reported only when another auth table is present,
because on its own it is almost certainly the application's own. Column names are compared with
separators and case ignored, so `user_id` and `userId` both match, and the report quotes whichever
the table really uses. Signatures taken from `getAuthTables({})` on `better-auth@1.6.28`.

Nothing about what is generated changes. Silently skipping a table because it looked like an auth
table is the failure the original decision was protecting against, and it stays protected against:

- `drzl doctor` gains a section naming each match, the columns it matched on, and the credential
  columns a generated read route would return.
- `drzl generate` warns for the tables carrying a credential, and only for those that survived the
  filter, so a config that already excludes them says nothing.

Both print the `exclude` line that closes it. One defect found on the way, by running the suggestion
rather than reading it: the first version printed `tables: { exclude: [...] }`, and `exclude` sits at
the top level of the config, so the parser ignored it and the warning kept firing after the user had
done exactly what it asked. A suggestion that does not work is worse than no suggestion, so a test
now parses the suggested key with the config schema itself.
