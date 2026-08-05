---
'@drzl/analyzer': patch
---

Seven Gel column types are described from what a live Gel server actually returns.

`boolean()` had no case in the analyzer's Gel arm at all and fell off the end to `unknown`, so every
generator emitted a field that refused nothing. The six `cal::` and duration columns were typed
`string`, which is worse: a wrong type rejects every row rather than accepting every value.

Measured on a live Gel 7.1 (`geldata/gel:7`, `sys::get_version_as_str()` -> `7.1+08db576`) through
`drizzle-orm/gel` 0.45.2 on `gel@2.2.0`, writing one row and reading it back:

```
column        gel-core declares        SELECT hands back    INSERT accepts
boolean       boolean                  boolean  true        -
timestamp     LocalDateTime            LocalDateTime        LocalDateTime
localDate     LocalDate                LocalDate            LocalDate
localTime     LocalTime                LocalTime            LocalTime
dateDuration  DateDuration             RelativeDuration     DateDuration
relDuration   RelativeDuration         RelativeDuration     RelativeDuration
duration      Duration                 RelativeDuration     Duration
timestamptz   Date        (control)    Date                 -
decimal       string      (control)    string  '12.34'      -
```

A string is refused on insert by all six and returned by none, so `string` was wrong in both
directions, not merely loose. `dateDuration` and `duration` contradict drizzle's own `.d.ts` on the
way out and agree with it on the way in; the server is the arbiter for both halves.

**What changes for you.** A Gel `boolean()` column now emits a real boolean check: `'yes'`, `12345`
and `{ a: 1 }` were accepted before and are rejected now. The six temporal columns now report
`tsType: 'unknown'`, so their emitted field goes from a string check that rejected every row to one
that accepts the value the driver hands back, and each raises a `DRZL_ANL_UNKNOWN_COLUMN` warning
naming its Gel type (`cal::local_datetime`, `cal::local_date`, `cal::local_time`, `dateDuration`,
`edgedbt.relative_duration_t`, `duration`).

**Why `unknown` and not a class name.** The value is an instance of a class from the `gel` package,
which DRZL cannot import, so no generator can emit a check for it. A tsType naming the class would
also suppress the unknown-column warning, which fires on `unknown`. Stating nothing and saying so is
the honest answer; the check itself stays open and is tracked separately.

**What does not change.** `integer`, `smallint`, `bigintT`, `bigint`, `text`, `uuid`, `json`, `real`,
`doublePrecision`, `decimal`, `bytes`, `timestamptz` and `.array()` are all unaffected, and every one
of them was read out of the same row.
