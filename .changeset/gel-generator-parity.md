---
---

Cover the Gel dialect on the generator side, which had no generator test at all.

`mssql` and `cockroach` have four and three specs between the generators and `singlestore` has two.
Gel had none, so what DRZL emits for it was a claim nobody had checked. It is also the only one of
the four that cannot be reached from drizzle v1: `gel-core` exists in 0.45.x and not in
`1.0.0-rc.4`, where `mssql-core` and `cockroach-core` were added and `gel-core` was dropped. No
single install has all four.

The new spec runs every one of `gel-core`'s eighteen column builders through a real `gelTable`, the
real analyzer and the real zod generator. Twelve read correctly, including two that would be easy to
conflate: `bigint` is a 53-bit integer drizzle hands back as a `number` while `bigintT` is Gel's
arbitrary-precision `edgedbt.bigint_t` and a real `bigint`, and `timestamptz` is an instant while
Gel's `timestamp` is a *local* datetime, unlike Postgres's.

Six have no type DRZL can describe, so their schemas accept anything: `dateDuration`, `duration`,
`localDate`, `localTime`, `relDuration` and `timestamp`. They hold classes from the `gel` driver
rather than primitives, so there is nothing a plain schema can check them against. Each raises
`DRZL_ANL_UNKNOWN_COLUMN`, which `doctor` surfaces, and the spec asserts both halves: narrowing one
later would be an improvement worth noticing, and dropping the warning would be a regression.

Tests and a devDependency only. No behaviour changes and no package is bumped.
