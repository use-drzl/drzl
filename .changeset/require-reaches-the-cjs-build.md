---
'@drzl/analyzer': minor
'@drzl/generator-arktype': minor
'@drzl/generator-json-schema': minor
'@drzl/generator-orpc': minor
'@drzl/generator-service': minor
'@drzl/generator-typebox': minor
'@drzl/generator-valibot': minor
'@drzl/generator-zod': minor
'@drzl/template-orpc-service': minor
'@drzl/template-standard': minor
'@drzl/validation-core': minor
---

`require('@drzl/…')` now reaches the CommonJS build, which is what these packages have been
shipping and could not deliver.

Every one of these packages built a `dist/index.cjs` and then published a manifest that could not
name it. Ten had no `exports` map at all, so `require('@drzl/generator-zod')` fell through to
`main`, which pointed at `dist/index.js` beside `"type": "module"`: an ES module. On Node 20.19 and
Node 22.12 and later, `require()` loads one anyway, so it worked and the `.cjs` sat unused. Below
those two versions it threw, against an `engines.node` of `>=18.17.0`:

```
ERR_REQUIRE_ESM: require() of ES Module
  /app/node_modules/@drzl/generator-zod/dist/index.js from /app/probe.cjs not supported.
```

Measured on a real install of the packed tarballs: broken on node 18.20.8, 20.18.3 and 22.11.0,
working on 20.19.6, 22.22.0 and 24.19.0. The ESM half was never affected, and a Node 18 consumer who
used `import` got correct output from all seven generators, which is why the floor stays at
`>=18.17.0` rather than being raised: the packages really do run there, and the manifest was what
was wrong.

Each package now declares both entries:

```json
"exports": {
  ".": {
    "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
  }
}
```

`@drzl/analyzer` was the one package whose `require` condition already named its `.cjs`, so it
loaded. Its single shared `types` still handed a CommonJS consumer the ESM declarations, and
`tsc --moduleResolution node16` rejected that with TS1479. It gets the same nested shape.

**What can break.** These are minors rather than patches for two reasons, both about consumers
doing something no DRZL documentation shows.

An `exports` map is a gate: `@drzl/validation-core/dist/index.js` and any other path inside the
package used to be importable and no longer is. Only the package root is a supported entry, and now
that is enforced rather than merely intended.

`main` moves from `dist/index.js` to `dist/index.cjs`, so a bundler old enough to ignore `exports`
now picks up the CommonJS build. A `module` field pointing at `dist/index.js` is published beside
it, which is what every bundler that predates `exports` reads first, so this only changes what the
few that read neither would resolve.

A consumer on Node 20.19 or newer who already used `require` gets the CommonJS bundle where they
previously got the ES module through Node's interop. The named exports and `default` are the same
either way, and `__esModule` is still true.
