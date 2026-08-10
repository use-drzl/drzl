<div align="center">

# @drzl/analyzer

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Fanalyzer)](https://www.npmjs.com/package/@drzl/analyzer)

</div>

Drizzle schema → normalized analysis for fast, reliable codegen.

</div>

## 💚 Sponsor DRZL

<div align="center">

<strong>DRZL is crafted nights & weekends. Sponsorships keep the generators fast, tested, and free.</strong>

[![Sponsor DRZL](https://img.shields.io/badge/GitHub%20Sponsors-Support%20the%20project-ff69b4?logo=github)](https://github.com/sponsors/omar-dulaimi)

</div>

- Every dollar speeds up CI hardware and offsets long test runs on my aging laptop.
- Sponsors get roadmap input and priority responses in GitHub Issues.
- Prefer a quick overview? The current goals and thank-yous are at
  https://use-drzl.github.io/drzl/sponsor.

## Use

```ts
import { SchemaAnalyzer } from '@drzl/analyzer';

const analyzer = new SchemaAnalyzer('src/db/schemas/index.ts');
const analysis = await analyzer.analyze({
  includeRelations: true,
  validateConstraints: true,
});
```

The CLI consumes this analysis to generate validation, services, and routers.

## Output (high level)

- dialect, tables, columns, keys, indexes
- relations (incl. inferred), enums
- issues (warnings/errors) for constraints and shape

Per column, beyond the type: `nullable`, `hasDefault`, `defaultValue` (literal defaults only),
`isGenerated`, `enumValues`, `maxLength` (characters), `maxBytes` (bytes, which is a different
measurement on the same kind of column), `min`/`max`, `arrayDimensions`, `format`, and `shape` for
values that are not scalars (json, buffer, tuple, numberObject, vector, bitstring, customType).

`maxBytes` is set by MySQL and nothing else. Its TEXT and BLOB families carry their limit in the
type rather than in a declared length, and count it in bytes: 255 for `tinytext` and `tinyblob`,
65535 for `text` and `blob`, 16777215 for the medium pair and 4294967295 for the long pair. A
`varchar(n)` is genuinely n characters and keeps `maxLength`. See
[the analyzer page](https://use-drzl.github.io/drzl/packages/analyzer) for how the generators
encode it.

`format` names a pattern in `COLUMN_FORMATS`, and two of its values name a dialect: a
`bigint({ mode: 'string' })` column is `pgBigint` on Postgres and `mysqlBigint` on MySQL and
SingleStore, because the two servers really do parse that text differently (`'0x1f'` is 31 on one
and an error on the other, `'12.5'` is 13 on one and an error on the other). SQL Server carries no
format for it, since none was measured.

`DRZL_ANL_UNKNOWN_COLUMN` is reported for any column whose validator would accept anything, which
is the shape a missing type mapping takes: nothing throws, and every row passes.

## Notes

- Best‑effort introspection aligned with Drizzle symbols across versions. Both live majors are
  covered and diffed against each other in CI: 0.4x and v1 model arrays and enums differently, and
  reading only one silently typed every `.array()` column as `unknown` on the other.
