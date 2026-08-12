---
'@drzl/cli': patch
---

Promote the six remaining generators from `optionalDependencies` to `dependencies`:
`@drzl/generator-h3`, `@drzl/generator-effect-http`, `@drzl/generator-ts-rest`,
`@drzl/generator-elysia`, `@drzl/generator-seed` and `@drzl/generator-fast-check`.

Each spent its introducing release in the optional field, because a package name that has never
existed cannot publish through npm's trusted-publisher OIDC flow, and naming it as a hard dependency
in the release that introduces it breaks `npm i @drzl/cli` for everyone until the first publish
lands. That is not hypothetical: 4.13.0 shipped that way and returned a 404 for every install. All
six were published by hand on 2026-08-12 and are on the registry at the same versions this workspace
carries, so the exemption is over.

An optional dependency is one an installer may skip without saying so: `npm install --omit=optional`
resolves it to nothing and exits 0. Leaving them there would have made six generator kinds silently
absent for anyone who passes that flag.

`@drzl/cli` now has no `optionalDependencies` block at all, `AWAITING_FIRST_PUBLISH` in
`packages/cli/test/generator-registry.spec.ts` is empty again, and
`scripts/verify/stages/33-registry-deps.sh` is what reported the promotion was due, by failing on a
generator that is optional *and* on the registry.

Three comments that carried a count of how many generators were hard dependencies are rewritten to
state the property instead. Each had been falsified by the next batch of generators, twice, and the
manifest test is where that quantity is actually checked.
