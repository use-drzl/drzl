/**
 * Every published package must be loadable by `require`, on a runtime that has no `require(esm)`.
 *
 * Ten packages built an ESM and a CJS bundle and then shipped a manifest that could only reach the
 * ESM one: no `exports` map, and `main` pointing at `dist/index.js` beside `"type": "module"`.
 * `require('@drzl/generator-zod')` therefore resolved to an ES module. Node 20.19 and Node 22.12
 * load one anyway, so on any current runtime it worked and the `dist/index.cjs` beside it was
 * never once the file that answered. Below those two lines it threw ERR_REQUIRE_ESM, against an
 * `engines.node` of `>=18.17.0`.
 *
 * The gap this closes is specific: `pnpm -r test` imports from source, and scripts/verify-packed.sh
 * installs the tarballs and drives them, but everything either of them does is an `import`. Nothing
 * required a package, so nothing could see that the require path resolved to the wrong file.
 *
 * `--no-experimental-require-module` is what makes this runnable on the Node in CI. It is not a
 * simulation of an old runtime: it turns off the same feature whose absence is the whole defect,
 * and it reproduces node:18.20.8 exactly, down to the error code and the resolved path. The canary
 * below fails the suite if the flag ever stops being in effect, because a require test on a runtime
 * that tolerates ESM would pass no matter what these manifests said.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const packagesDir = path.join(repoRoot, 'packages');

interface Manifest {
  name: string;
  private?: boolean;
  bin?: unknown;
  scripts: Record<string, string>;
}

/**
 * Which packages this applies to, read off the manifests rather than listed here.
 *
 * A package with a `bin` is excluded: its entry is a program, and requiring it would run the
 * program. That is a declaration in the manifest, not a name in this file, so a package that
 * gains or loses one moves in and out of scope on its own.
 */
async function subjects(): Promise<{ dir: string; manifest: Manifest }[]> {
  const dirs = (await fs.readdir(packagesDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const out: { dir: string; manifest: Manifest }[] = [];
  for (const dir of dirs) {
    const file = path.join(packagesDir, dir, 'package.json');
    let manifest: Manifest;
    try {
      manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      continue;
    }
    if (manifest.private) continue;
    if (manifest.bin) continue;
    out.push({ dir, manifest });
  }
  return out;
}

/**
 * A node_modules tree built from each package's real manifest and a fresh run of its own build
 * script, outside the workspace so that Node's resolver cannot walk up into this repo and find
 * something else to answer with.
 */
async function buildSandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-require-'));
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"require-probe","private":true}');
  const scope = path.join(root, 'node_modules', '@drzl');
  await fs.mkdir(scope, { recursive: true });

  const list = await subjects();
  await Promise.all(
    list.map(async ({ dir, manifest }) => {
      const from = path.join(packagesDir, dir);
      const to = path.join(scope, dir);
      await fs.mkdir(to, { recursive: true });
      execFileSync('pnpm', ['exec', 'sh', '-c', `${manifest.scripts.build} --out-dir ${to}/dist`], {
        cwd: from,
        stdio: 'pipe',
      });
      await fs.copyFile(path.join(from, 'package.json'), path.join(to, 'package.json'));
    })
  );

  // The canary. An ES module in a package that says so, which a runtime with require(esm) off
  // must refuse. Nothing about DRZL is under test here; it is the flag that is.
  const canary = path.join(root, 'node_modules', 'esm-canary');
  await fs.mkdir(canary, { recursive: true });
  await fs.writeFile(
    path.join(canary, 'package.json'),
    JSON.stringify({ name: 'esm-canary', version: '0.0.0', type: 'module', main: 'index.js' })
  );
  await fs.writeFile(path.join(canary, 'index.js'), 'export const marker = 1;\n');

  return { root, names: list.map((s) => s.manifest.name) };
}

interface RequireResult {
  ok: boolean;
  resolved?: string;
  keys?: string[];
  code?: string;
  message?: string;
}

let sandbox: { root: string; names: string[] };
let required: Record<string, RequireResult>;
let canary: RequireResult;
let imported: Record<string, string[]>;

beforeAll(async () => {
  sandbox = await buildSandbox();

  await fs.writeFile(
    path.join(sandbox.root, 'probe.cjs'),
    [
      "const path = require('node:path');",
      'const names = JSON.parse(process.argv[2]);',
      'const out = {};',
      'const attempt = (name) => {',
      '  try {',
      '    const resolved = require.resolve(name);',
      '    const mod = require(name);',
      '    return { ok: true, resolved: path.relative(__dirname, resolved), keys: Object.keys(mod).sort() };',
      '  } catch (err) {',
      '    return { ok: false, code: err.code || err.name, message: String(err.message).split("\\n")[0] };',
      '  }',
      '};',
      "out.__canary = attempt('esm-canary');",
      'for (const name of names) out[name] = attempt(name);',
      'process.stdout.write(JSON.stringify(out));',
    ].join('\n')
  );

  await fs.writeFile(
    path.join(sandbox.root, 'probe.mjs'),
    [
      'const names = JSON.parse(process.argv[2]);',
      'const out = {};',
      'for (const name of names) out[name] = Object.keys(await import(name)).sort();',
      'process.stdout.write(JSON.stringify(out));',
    ].join('\n')
  );

  const arg = JSON.stringify(sandbox.names);
  const cjsRaw = execFileSync(
    process.execPath,
    ['--no-experimental-require-module', 'probe.cjs', arg],
    { cwd: sandbox.root, encoding: 'utf8' }
  );
  const parsed = JSON.parse(cjsRaw);
  canary = parsed.__canary;
  delete parsed.__canary;
  required = parsed;

  imported = JSON.parse(
    execFileSync(process.execPath, ['probe.mjs', arg], { cwd: sandbox.root, encoding: 'utf8' })
  );
}, 180_000);

describe('the harness itself', () => {
  it('really has require(esm) turned off, or nothing below means anything', () => {
    expect(canary.ok).toBe(false);
    expect(canary.code).toBe('ERR_REQUIRE_ESM');
  });

  it('has something to check', () => {
    // A `subjects()` that stopped matching would leave every assertion below iterating an empty
    // list and passing. The floor is the shared package this file lives in plus the analyzer that
    // sits under everything, so an empty or nearly empty result is a broken discovery, not a
    // workspace that shrank.
    expect(sandbox.names).toContain('@drzl/validation-core');
    expect(sandbox.names).toContain('@drzl/analyzer');
    expect(Object.keys(required).sort()).toEqual([...sandbox.names].sort());
  });

  it('read a non-empty API out of every package, both ways', () => {
    // The parity assertion below compares two lists of export names. Two empty lists are equal,
    // so without this a build that emitted nothing would satisfy it. Every one of these packages
    // exports at least a default, so the floor is one name per package per direction.
    const empty = sandbox.names.filter(
      (name) => !required[name]?.keys?.length || !imported[name]?.length
    );
    expect(empty).toEqual([]);
  });
});

describe('every published package, required on a runtime without require(esm)', () => {
  it('loads', () => {
    // This is the whole runtime contract, and it is stronger than it looks. With require(esm)
    // off, anything that loads was CommonJS, so a separate assertion that the resolved file ends
    // in `.cjs` adds nothing: pointing the require condition at `dist/index.js` was tried here and
    // this assertion is what caught it, not the extension check that used to sit below. The
    // resolved path rides along in the message so a failure names the file that answered.
    const broken = Object.entries(required)
      .filter(([, r]) => !r.ok)
      .map(([name, r]) => `${name}: ${r.code}`);
    const answered = Object.entries(required)
      .filter(([, r]) => r.ok)
      .map(([name, r]) => `${name} <- ${r.resolved}`);
    expect(broken, `loaded: ${answered.join(', ')}`).toEqual([]);
  });

  it('exposes the same names the ESM entry does', () => {
    // Two bundles from one source, reached by two conditions. A consumer who requires must get the
    // API a consumer who imports gets, or the `require` condition points somewhere plausible and
    // wrong.
    const mismatched: string[] = [];
    for (const [name, r] of Object.entries(required)) {
      if (!r.ok) continue;
      const viaImport = imported[name];
      if (JSON.stringify(r.keys) !== JSON.stringify(viaImport)) {
        mismatched.push(`${name}: require=[${r.keys}] import=[${viaImport}]`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('carries CommonJS type declarations tsc will accept under node16', () => {
    // The runtime half of this defect has a shadow in the type system, and the two are not the
    // same check. `moduleResolution: node16` models a Node that cannot require an ES module, so
    // it follows the `require` condition and then refuses whatever `.d.ts` it lands on if that
    // file belongs to a `"type": "module"` package. A manifest whose require condition is a bare
    // string, sharing one `types` with the import condition, resolves at runtime and still fails
    // here: that is the state @drzl/analyzer was in, and tsc reported TS1479 for it while every
    // require above passed.
    //
    // `nodenext` does not see it, because TypeScript 5 models require(esm) there. So node16 is
    // the leg that matters and running only the newer one would prove nothing.
    const consumer = path.join(sandbox.root, 'consumer.cts');
    const lines = sandbox.names.map((name, i) => `import * as m${i} from ${JSON.stringify(name)};`);
    lines.push(`export const used = [${sandbox.names.map((_, i) => `m${i}`).join(', ')}];`);
    // Written synchronously in the test body so a failure points at this file rather than at a
    // setup hook.
    writeFileSync(consumer, lines.join('\n') + '\n');

    const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    let output = '';
    try {
      execFileSync(
        process.execPath,
        [
          tsc,
          '--noEmit',
          '--strict',
          '--skipLibCheck',
          '--module',
          'node16',
          '--moduleResolution',
          'node16',
          '--target',
          'es2022',
          consumer,
        ],
        { cwd: sandbox.root, stdio: 'pipe', encoding: 'utf8' }
      );
    } catch (err) {
      output = String((err as { stdout?: string }).stdout ?? err);
    }
    expect(output.trim()).toBe('');
  });
});
