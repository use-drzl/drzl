---
'@drzl/cli': patch
---

Promote the four generators introduced this week from `optionalDependencies` to `dependencies`:
`@drzl/generator-mcp`, `@drzl/generator-next`, `@drzl/generator-ai` and
`@drzl/generator-tanstack-start`.

Each spent exactly one release in the optional field, because a package name that has never existed
cannot publish through npm's trusted-publisher OIDC flow and naming it as a hard dependency in the
release that introduces it breaks `npm i @drzl/cli` for everyone until the first publish lands.
All four are on the registry now, so the exemption is over.

An optional dependency is one an installer may skip without saying so: `npm install --omit=optional`
resolves it to nothing and exits 0. Leaving them there would have made four generator kinds silently
absent for anyone who passes that flag.

`scripts/verify/stages/33-registry-deps.sh` is what reported the promotion was due, by failing on a
generator that is optional *and* on the registry, and `AWAITING_FIRST_PUBLISH` in
`packages/cli/test/generator-registry.spec.ts` is now empty.
