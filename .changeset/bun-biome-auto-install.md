---
'@drzl/validation-core': patch
---

Biome formatting is refused unless Biome is actually installed in the project, which makes generated
output byte-identical under Bun and Node again

Under Bun, `drzl generate` emitted differently formatted files from Node over the same schema and the
same config, and reached the network to do it. Measured on a packed install of `@drzl/cli` 4.22.0
against Bun 1.3.14, Node 22.22.0 and Deno 2.9.5, in a project whose package.json had never mentioned
Biome: Node emitted the generator's own two-space output, and Bun emitted tab-indented Biome output,
after downloading `@biomejs/biome` 2.5.7 and a multi-megabyte platform binary mid-generate. Running
`drzl generate --check` under Node against the Bun-generated tree then reported every file out of
date, which is a CI failure produced entirely by the choice of runtime.

**The mechanism is that resolving a package is not the same question as having it installed, on one
runtime.** `formatCode`'s `auto` engine tries prettier, then Biome. The Biome branch locates the
binary with `createRequire(...).resolve('@biomejs/biome/package.json')`, because the package declares
only `bin` and cannot be imported. Node and Deno answer a missing package with MODULE_NOT_FOUND,
which `formatCode` catches, leaving the code unformatted. Bun answers it by auto-installing from npm
and resolving into its own global cache:

```
node -> MODULE_NOT_FOUND
deno -> MODULE_NOT_FOUND
bun  -> ~/.bun/install/cache/@biomejs/biome@2.5.7@@@1/package.json
```

It was not even stable within Bun. Whether the auto-install fired depended on the state of that
cache, so the same command on the same tree emitted different bytes at different times: with the
cache cold it installed and formatted, with the package present it formatted, and with the package
deleted but the manifest cache warm it did not.

**A second, independent Bun difference sat behind it.** Resolution was one `createRequire` with
`resolve(spec, { paths: [outputDir, process.cwd()] })`. Node honours that list; Bun does not. With
Biome genuinely installed and an absolute `outDir` pointing outside the project, which is the exact
case `paths` was added for, Node fell back to the working directory and found the real install while
Bun never tried the second entry and auto-installed instead. Fixing only the first half would have
left a Bun user who really had installed Biome with no formatting at all.

**What changes.** `isProjectInstallPath` is exported and gates the resolution: a manifest reached
through a `node_modules` path segment is a project install, and anything else is refused. That
discriminator is exact rather than a heuristic, since npm, pnpm's `.pnpm` store and Yarn PnP's zip
and unplugged paths all reach a package through one, and Bun's auto-install cache is the only shape
that does not. Resolution now anchors a separate `createRequire` at each candidate directory in turn,
output directory first and working directory second, preserving the order of the `paths` array it
replaces. Under Node and Deno the guard can never fire, because their resolvers have no other kind of
path to return, so neither runtime changes at all.

**Measured after the fix**, on packed tarballs installed with npm, with an absolute `outDir` outside
the project: with no Biome installed, Node and Bun emit byte-identical unformatted output and Bun no
longer spawns anything; with Biome installed, Node and Bun emit byte-identical Biome-formatted
output. With the output directory inside the project, Node, Bun and Deno agree byte for byte in both
cases. Red-first: the guard's spec fails against the previous code, and the working-directory
fallback has a must-fire test that fails when that anchor is removed.
