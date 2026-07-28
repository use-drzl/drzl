<div align="center">

# @drzl/validation-core

<div align="center">

[![CI](https://github.com/use-drzl/drzl/actions/workflows/ci.yml/badge.svg)](https://github.com/use-drzl/drzl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40drzl%2Fvalidation-core)](https://www.npmjs.com/package/@drzl/validation-core)

</div>

Shared interfaces and helpers used by validation generators.

</div>

## 💚 Sponsor DRZL

<div align="center">

<strong>DRZL is crafted nights & weekends. Sponsorships keep the generators fast, tested, and free.</strong>

[![Sponsor DRZL](https://img.shields.io/badge/GitHub%20Sponsors-Support%20the%20project-ff69b4?logo=github)](https://github.com/sponsors/omar-dulaimi)

</div>

- Every dollar speeds up CI hardware and offsets long test runs on my aging laptop.
- Sponsors get roadmap input and priority responses in GitHub Issues.
- Prefer a quick overview? Check `docs/sponsor.md` for the current goals and thank-yous.

## Exports (essentials)

- ValidationLibrary: `'zod' | 'valibot' | 'arktype'`
- ValidationRenderer<TOptions>
  - `library`
  - `renderTable(table, opts)`
  - `renderIndex?(analysis, opts)`
- Helpers
  - `insertColumns(table)`, `updateColumns(table)`, `selectColumns(table)`
  - `formatCode(code, filePath, formatOpts)`
- File names (shared by every generator that writes a file and a barrel)
  - `moduleFileName(tsName, fileSuffix)` -> `users.zod.ts`
  - `moduleSpecifier(tsName, fileSuffix)` -> `./users.zod`, the specifier a sibling module
    needs to import that file. `.mts` and `.cts` become `.mjs` and `.cjs`, since an
    extensionless specifier never resolves to them.
  - Both read the same `fileSuffix`, so a barrel can never name a file that was not written.
- Naming (shared by every generator that emits a schema name)
  - `resolveAffix({ affix, schemaSuffix })` -> `ResolvedAffix`
  - `schemaName(mode, tsName, resolved)`, `typeName(mode, tsName, resolved)`
  - `validateAffix(affix, schemaSuffix)` -> issues for unusable or colliding names
  - `pascalCase(s)`, `applyTableCase(tsName, 'preserve' | 'pascal')`
  - Calling `resolveAffix()` with no options reproduces the original naming exactly, so the
    generators and the oRPC router can never interpret one config two ways.
