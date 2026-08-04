import { defineConfig } from 'tsup';

/**
 * Entry points, formats and flags stay in the `build` script; this file exists for the one thing
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
  esbuildOptions(options, context) {
    if (context.format !== 'cjs') return;
    options.banner = {
      js: `"use strict";var __drzlModuleUrl = require("node:url").pathToFileURL(__filename).href;`,
    };
    options.define = { ...options.define, 'import.meta.url': '__drzlModuleUrl' };
  },
});
