/**
 * The version `drzl --version` prints, read from the manifest that ships beside the build.
 *
 * It used to be the literal `'0.0.1'`, passed to `program.version()` when the CLI was scaffolded
 * and never touched again. That was true of exactly one release, the first: the registry lists 29
 * versions of `@drzl/cli`, and the other 28 printed `0.0.1` as well. Reading the manifest is the
 * only form that cannot drift, because it is the same file the registry took the version from.
 *
 * Nothing here falls back. A build that cannot find its own manifest, or finds someone else's, has
 * resolved somewhere it did not intend to, and a placeholder standing in for that is how the
 * original defect stayed invisible for 28 releases.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The name the manifest beside this build must carry, which is what makes it ours. */
const PACKAGE_NAME = '@drzl/cli';

/**
 * The directory holding the file this code ends up in, in every form it is reached.
 *
 * Three of them: `dist/cli.js`, `dist/cli.cjs`, and this file unbundled under ts-node, all three
 * run and checked. Only the CommonJS bundle has no `import.meta`; `tsup.config.ts` gives that
 * build a real value for `import.meta.url` rather than esbuild's empty one, so this needs no
 * branch. If that config is ever dropped, `fileURLToPath(undefined)` throws on load, so the
 * CommonJS bundle stops working loudly instead of reporting the wrong directory.
 */
function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * The `version` a named manifest declares, or a throw naming what was wrong with it.
 *
 * Split out from the caller below only so the three ways it refuses can be exercised without a
 * build. Nothing in the CLI passes a path.
 */
export function readVersionFrom(manifestPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (e: any) {
    throw new Error(
      `${PACKAGE_NAME} cannot read its own version: no manifest at ${manifestPath} ` +
        `(${e?.message ?? String(e)}).`
    );
  }

  const manifest = JSON.parse(raw) as { name?: unknown; version?: unknown };

  if (manifest.name !== PACKAGE_NAME) {
    throw new Error(
      `${PACKAGE_NAME} looked for its own version in ${manifestPath} and found ` +
        `${JSON.stringify(manifest.name)}, so this build is not sitting where it thinks it is.`
    );
  }

  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`${manifestPath} declares no version, so there is nothing to report.`);
  }

  return manifest.version;
}

/**
 * The `version` field of this package's own manifest.
 *
 * Both bundles sit one level below it, in `dist/`, and so does `src/` when this file is run
 * unbundled, so one `..` covers every way it is reached. All three were run.
 */
export function readCliVersion(): string {
  return readVersionFrom(path.join(moduleDir(), '..', 'package.json'));
}

export const CLI_VERSION = readCliVersion();
