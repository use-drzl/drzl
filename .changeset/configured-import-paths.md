---
'@drzl/validation-core': minor
'@drzl/generator-orpc': patch
'@drzl/generator-service': patch
---

`validation.importPath`, `dbImportPath` and `schemaImportPath` now produce imports that resolve.
They were emitted verbatim, so the config in the getting-started guide generated three imports
that resolved to nothing, under every module resolution.

These options get written as project-relative paths, `src/validators/zod`, because that is how
the rest of the config names directories. Emitted verbatim that is a *bare* specifier: Node and
tsc look for a package of that name in node_modules and never consider the local file.

    from "src/validators/zod"          before
    from "../validators/zod/index.js"  after

Each configured path is now classified before use. A package name (`zod`, `@acme/schemas`) is
left exactly as written. A path already relative keeps its own spelling and only has its
extension corrected, so anyone who followed the older guidance and wrote
`../validators/zod/index.js` is unaffected. Anything else is treated as project-relative and
rewritten against the directory of the file doing the importing.

Whether a path names a file or a directory is asked of the filesystem, because
`src/db/connection` and `src/validators/zod` are indistinguishable as strings and are usually a
file and a directory holding a barrel. A directory gains `/index`. Where nothing exists yet,
which happens when one generator runs before the one that writes its target, an extensionless
path is taken to be a directory, since these options name directories by convention and the only
path that can legitimately be missing is a generated barrel.

Since a non-relative value could only ever have produced an import that resolved to nothing,
rewriting it cannot break a setup that worked.

Exposed by `resolveConfiguredImport` in `@drzl/validation-core`, so all three call sites share
one rule.
