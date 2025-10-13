# feat(analyzer): add MySQL, SingleStore, Gel mappings; expand Pg/SQLite; add tests

Closes #13

## Summary
Adds comprehensive type inference for Drizzle ORM column constructors beyond Postgres/SQLite, fixing the MySQL issue where Zod schemas were generated as `z.unknown()`.
- MySQL: map mysql-core constructors to correct ts types
- SingleStore: map singlestore-core constructors (incl. `vector`) and detect dialect
- Gel (EdgeDB): map gel-core constructors and detect dialect
- Postgres: expand coarse mappings (time, interval, inet/cidr/macaddr, point/line, string-mode date/timestamp)
- SQLite: keep mappings; confirm timestamp mode heuristic
- Dialect detection extended to `'mysql' | 'singlestore' | 'gel'`

## Changes
- analyzer
  - Map constructors → `tsType` and `dbType` for MySQL, SingleStore, Gel
  - Expand Postgres + SQLite heuristics
  - Dialect detection for mysql/singlestore/gel
- tests
  - Add focused tests: MySQL, SingleStore, Gel, Postgres, SQLite
  - Add fixtures ignore to avoid committing ephemeral .mjs fixtures

## Why
- Fixes bug where MySQL schemas produced `z.unknown()` in generators (Zod, Valibot, etc.).
- Ensures consistent behavior across Drizzle dialects supported in upstream sources.

## Validation
- Build: `pnpm -r build`
- Tests: `pnpm -r test -- --run`
- Manual: MySQL mirror of #13 verified via Zod generator (outside of PR scope; validated locally).

## Notes
- Postgres network/geometry types are modeled as `string` for stable generator behavior.
- SingleStore `vector` is modeled as `any` initially; can be refined to `number[]` with generator support on request.
- No breaking changes expected; generators benefit automatically from improved `tsType`.

## Screens/CLI logs (abridged)
```
Detected dialect: mysql
Generated files:
 - src/mysql/zod/usersTable.zod.ts
import { z } from 'zod';
export const InsertusersTableSchema = z.object({
  "name": z.string(),
  "age": z.number().int(),
  "email": z.string(),
});
...
```
