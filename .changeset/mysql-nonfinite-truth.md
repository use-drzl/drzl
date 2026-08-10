---
'@drzl/analyzer': patch
---

Correct what `allowsNaN` says about MySQL, which was true of the wrong client path

The doc comment on `Column.allowsNaN` said a MySQL `decimal` "refuses them outright rather than
storing `0.00`". That is the text path's answer, through the `mysql` CLI. It is not what happens on
the binary prepared path `mysql2`'s `execute()` uses, which is the one drizzle takes and the one a
validator sits in front of. Measured on 8.4.11 in `STRICT_TRANS_TABLES`:

```
float, double     all three refused, "Out of range value"
decimal(10,2)     all three stored as 0.00, silently, SHOW WARNINGS empty
int               NaN stored as 0 silently; both infinities refused
bigint            NaN stored as the int64 minimum silently; both infinities refused
```

A control rules out ordinary overflow: a finite `1e308` into the same `decimal(10,2)` is refused.

The comment ships in the published type declarations, so this is a change to the artifact rather
than a repository-only edit. No behaviour changes: the flag was already `false` on every MySQL
numeric and the test suite already pinned the decimal case, both correctly. What the comment now
also states is why `false` is right even though the server takes the row: it is not accepting the
value, it is storing a different one, and a validator whose job is to say what the database will do
with a write cannot call that acceptance.
