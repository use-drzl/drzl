import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

/**
 * Every package this one declares, whichever field declares it.
 *
 * tsup decides externals from `dependencies` and `peerDependencies` and from nothing else. That
 * is read out of its own build rather than assumed: `getProductionDeps` in
 * `tsup/dist/chunk-VGC3FXLU.js` is `new Set([...Object.keys(data.dependencies || {}),
 * ...Object.keys(data.peerDependencies || {})])`, and `runEsbuild` turns exactly that set into
 * the `^name($|/|\\)` patterns the external plugin matches on.
 *
 * `optionalDependencies` is not in it, so a package declared there is bundled: its code is copied
 * into `dist` and the declaration describes an install that has nothing to do with what runs.
 * Eight generator packages sat in that field for publishing reasons that no longer hold, and the
 * effect was that half the generators were resolved from `node_modules` and half travelled inside
 * the CLI, from one list nobody had written down.
 *
 * The rule is the manifest, not a list: everything the manifest declares is resolved at runtime,
 * and nothing declared is copied in. There is no array here for the next generator to be missing
 * from, because adding a generator to this package means adding it to `dependencies`, and that is
 * the same edit.
 *
 * Read from beside this file rather than from `process.cwd()`. tsup loads a config through
 * bundle-require, whose `injectFileScopePlugin` defines `import.meta.url` as the file URL of the
 * config's own source path, so this resolves to `packages/cli/package.json` however the build was
 * invoked.
 */
const manifest = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')
) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const declaredDependencies = Object.keys({
  ...manifest.dependencies,
  ...manifest.optionalDependencies,
  ...manifest.peerDependencies,
});

/**
 * Entry points, formats and flags stay in the `build` script; this file exists for the two things
 * a tsup CLI flag cannot express.
 *
 * `src/version.ts` reads `import.meta.url` to find the manifest sitting beside the build. esbuild
 * has no such thing in a CommonJS output: it rewrites `import.meta` to `{}`, warns
 * `empty-import-meta`, and leaves `import.meta.url` as `undefined` at runtime. That is the same
 * shape as the `createRequire(import.meta.url)` defect in `@drzl/validation-core`, where the CJS
 * bundle got `createRequire(undefined)` and a `catch {}` hid it.
 *
 * So the CommonJS build gets a real value instead of a silenced warning: a banner computes the
 * module URL from `__filename`, which CommonJS does have, and `define` points `import.meta.url` at
 * it. Silencing the warning would have worked equally well for `version.ts`, which throws rather
 * than reads `undefined`, and would have left the next unguarded `import.meta.url` in this package
 * resolving to `undefined` with nothing on stdout to say so.
 *
 * The banner repeats `"use strict"` because it lands above esbuild's own copy, and a `var` ahead of
 * that directive ends the prologue and drops the whole bundle into sloppy mode. Checked by running
 * a file shaped that way, not inferred: an assignment to an undeclared name succeeded.
 *
 * esbuild hoists the hashbang above the banner, so `dist/cli.cjs` still starts with
 * `#!/usr/bin/env node`.
 */
export default defineConfig({
  external: declaredDependencies,
  esbuildOptions(options, context) {
    if (context.format !== 'cjs') return;
    options.banner = {
      js: `"use strict";var __drzlModuleUrl = require("node:url").pathToFileURL(__filename).href;`,
    };
    options.define = { ...options.define, 'import.meta.url': '__drzlModuleUrl' };
  },
});
