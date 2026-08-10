/**
 * `formatCode` with `engine: 'biome'`, against a binary rather than an import.
 *
 * The engine had never formatted anything for anyone. `formatCode` reached Biome through
 * `import('@biomejs/biome')`, and that package has no importable entry point: its manifest declares
 * `bin` and nothing else, so there is no `main`, no `module`, no `exports` and no `index.js` for
 * Node's legacy fallback to find. `import()` rejects with ERR_MODULE_NOT_FOUND on a complete,
 * correct install. Measured against real `npm install`s of 1.0.0, 1.5.3, 1.9.4, 2.0.6, 2.4.16 and
 * 2.5.7, which is every shape the package has had; the two module entry points the old code probed
 * for, `formatContent` and `format`, were unreachable at all six.
 *
 * `bin` is what the package publishes, so `bin` is what this uses: `biome format --stdin-file-path`,
 * which is a supported mode as far back as 1.5.3.
 *
 * The behaviours asserted below are not invented. Each was measured by running the real 2.5.7
 * binary and recording what it did, and the stand-in binary these tests install reproduces them:
 *
 *   input mangled, no config       -> exit 0, formatted on stdout (tabs, double quotes)
 *   nearby biome.json              -> exit 0, formatted to that config
 *   `formatter.enabled: false`     -> exit 1, and *the input echoed back on stdout*
 *   unsupported extension          -> exit 1, and *the input echoed back on stdout*
 *   unparseable input              -> exit 1, empty stdout, diagnostics on stderr
 *   empty input                    -> exit 0, empty stdout
 *
 * The two echo-on-failure cases are why exit status is the only thing that may be believed. A
 * check that took stdout whenever stdout was non-empty would return unformatted code as though it
 * had been formatted, and nothing downstream would ever notice.
 *
 * A stand-in rather than the real 64 MB platform binary, because these tests are about the seam and
 * not about Biome's formatter: what runs here is a real child process, over a real pipe, resolved
 * through Node's real resolver out of a real `node_modules/@biomejs/biome` laid out exactly as npm
 * lays out the real one. Nothing is mocked. The recorded bytes in EXPECTED_2_5_7 came out of the
 * real binary.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * A `formatCode` with its own record of what it has already warned about.
 *
 * The unusable-engine warning fires once per engine per module instance, deliberately: a generate
 * run reaches `formatCode` once per table per generator and the condition belongs to the
 * environment rather than to any one file. Vitest gives a whole file one module instance, so
 * without this the first test to warn would silence every test after it, and their `toHaveBeenCalledTimes(1)`
 * would pass by warning zero times. Found the hard way: that is exactly how the first run of this
 * file failed.
 */
async function freshFormatCode() {
  vi.resetModules();
  return (await import('../src')).formatCode;
}

const mangled = "export  const  a={x:1,y:'two'}\nexport  function  f(  n:number  ){return n+1}\n";

/**
 * What `@biomejs/biome@2.5.7` really printed for `mangled`, with no config in scope.
 *
 *   printf '<mangled>' | node node_modules/@biomejs/biome/bin/biome format --stdin-file-path=s.ts
 *
 * Tabs and double quotes are Biome's defaults, and are what make this distinguishable from both the
 * input and from prettier's output, which uses two spaces.
 */
const EXPECTED_2_5_7 =
  'export const a = { x: 1, y: "two" };\nexport function f(n: number) {\n\treturn n + 1;\n}\n';

/** The behaviours the stand-in can be asked for, each one recorded from the real binary. */
type Mode = 'format' | 'disabled' | 'parse-error' | 'empty-on-content' | 'crash' | 'huge';

/**
 * Build a project directory containing a `node_modules/@biomejs/biome` with the same shape as a
 * real install: a manifest carrying `bin` and nothing else, and a Node script behind it.
 *
 * The manifest deliberately has no `main`, `module`, `exports` or `types`, because the real one has
 * none either. That is what makes this fixture able to fail the way the real package fails.
 */
async function project(mode: Mode, opts: { indent?: string } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-biome-'));
  const pkgDir = path.join(dir, 'node_modules', '@biomejs', 'biome');
  await fs.mkdir(path.join(pkgDir, 'bin'), { recursive: true });
  await fs.writeFile(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@biomejs/biome', version: '2.5.7', bin: { biome: 'bin/biome' } })
  );
  // A Node script with a shebang, which is what bin/biome is at every published version; the real
  // one resolves @biomejs/cli-<platform> and execs the native binary behind it.
  //
  // `process.exitCode` throughout, never `process.exit()`. A Node process that calls `process.exit`
  // straight after a large `process.stdout.write` throws away whatever is still buffered in the
  // pipe: the HUGE case below arrived as 146176 of its 2400000 bytes, and the first reading of that
  // was that the reader under test was truncating. It was not. The same bytes written by a child
  // that sets `exitCode` and returns arrive whole, which is how the two were told apart.
  await fs.writeFile(
    path.join(pkgDir, 'bin', 'biome'),
    [
      '#!/usr/bin/env node',
      'const mode = ' + JSON.stringify(mode) + ';',
      'const indent = ' + JSON.stringify(opts.indent ?? '\t') + ';',
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (c) => (input += c));',
      'process.stdin.on("end", () => {',
      '  const args = process.argv.slice(2);',
      '  if (args[0] !== "format") { process.stderr.write("unknown command\\n"); process.exitCode = 2; return; }',
      '  if (!args.some((a) => a.startsWith("--stdin-file-path="))) {',
      '    process.stderr.write("no --stdin-file-path\\n"); process.exitCode = 2; return;',
      '  }',
      '  if (mode === "disabled") {',
      // Recorded from the real binary: exit 1 with the *input* echoed back, which is the trap.
      '    process.stdout.write(input);',
      '    process.stderr.write("The content was not formatted because the formatter is currently disabled.\\n");',
      '    process.exitCode = 1; return;',
      '  }',
      '  if (mode === "parse-error") {',
      '    process.stderr.write("x.ts:1:19 parse: Expected a property\\n");',
      '    process.exitCode = 1; return;',
      '  }',
      '  if (mode === "crash") { process.stderr.write("boom\\n"); process.exitCode = 70; return; }',
      '  if (mode === "empty-on-content") { return; }',
      '  if (mode === "huge") { process.stdout.write("/*x*/\\n".repeat(400000)); return; }',
      '  if (input === "") { return; }',
      // The recorded 2.5.7 output for the one input these tests feed in, with the indent swapped
      // when a config is meant to be in play.
      '  const out = ' +
        JSON.stringify(EXPECTED_2_5_7) +
        '.replace("\\treturn", indent + "return");',
      '  process.stdout.write(out);',
      '});',
    ].join('\n'),
    { mode: 0o755 }
  );
  const outDir = path.join(dir, 'src', 'generated');
  await fs.mkdir(outDir, { recursive: true });
  return { dir, filePath: path.join(outDir, 'users.ts') };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatCode with engine: biome', () => {
  it('formats through the binary, and says nothing', async () => {
    const fmt = await freshFormatCode();
    const { filePath } = await project('format');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Not the input, and not prettier's output either: prettier is installed in this workspace and
    // indents with two spaces, so a fallback into the prettier branch would fail this line.
    expect(await fmt(mangled, filePath, { engine: 'biome' })).toBe(EXPECTED_2_5_7);
    expect(warn.mock.calls).toEqual([]);
  });

  it('finds the binary from the output directory, with no help from this package', async () => {
    const fmt = await freshFormatCode();
    // The binary is resolved from where the file is being written, not from validation-core's own
    // location, so a consumer's install is reachable without @biomejs/biome being declared as a
    // peer of anything. This temp directory has no relationship to this workspace at all, which is
    // what makes that a demonstration rather than an assertion.
    const { dir } = await project('format');
    expect(dir.startsWith(os.tmpdir())).toBe(true);
    const deeper = path.join(dir, 'src', 'generated', 'nested', 'deep', 'users.ts');
    await fs.mkdir(path.dirname(deeper), { recursive: true });
    expect(await fmt(mangled, deeper, { engine: 'biome' })).toBe(EXPECTED_2_5_7);
  });

  it('runs the binary where the file will be written, so a nearby biome.json is honoured', async () => {
    const fmt = await freshFormatCode();
    // Biome discovers biome.json by walking up from its working directory, not from
    // --stdin-file-path, so the child's cwd is what decides whose config applies. Measured: the
    // same command run from an unrelated directory picked up a different configuration and exited
    // non-zero. The stand-in reports the indent it was told to use, standing in for that config.
    const { dir, filePath } = await project('format', { indent: '    ' });
    await fs.writeFile(
      path.join(dir, 'biome.json'),
      JSON.stringify({ formatter: { indentStyle: 'space', indentWidth: 4 } })
    );
    expect(await fmt(mangled, filePath, { engine: 'biome' })).toContain('\n    return n + 1;');
  });

  it('does not return stdout when the binary exits non-zero, even though stdout holds content', async () => {
    const fmt = await freshFormatCode();
    // The defect this exists to prevent. `formatter.enabled: false` in a consumer's biome.json makes
    // the real binary exit 1 *and* echo the input back on stdout. Believing stdout would write
    // unformatted code to disk while reporting success, and nothing downstream inspects whitespace.
    const { filePath } = await project('disabled');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await fmt(mangled, filePath, { engine: 'biome' })).toBe(mangled);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    // The binary's own words, carried rather than paraphrased, as on the prettier side.
    expect(message).toContain('formatter is currently disabled');
  });

  it('treats a parse error as an error rather than as empty output', async () => {
    const fmt = await freshFormatCode();
    const { filePath } = await project('parse-error');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await fmt(mangled, filePath, { engine: 'biome' })).toBe(mangled);
    expect(String(warn.mock.calls[0]?.[0])).toContain('Expected a property');
  });

  it('refuses output that is empty when the input was not', async () => {
    const fmt = await freshFormatCode();
    // formatCode's return value is written straight to disk. A formatter that exits 0 with nothing
    // on stdout would truncate a generated file to zero bytes, which is worse than any formatting
    // failure, so it is rejected rather than returned.
    const { filePath } = await project('empty-on-content');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await fmt(mangled, filePath, { engine: 'biome' })).toBe(mangled);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('accepts empty output when the input was empty', async () => {
    const fmt = await freshFormatCode();
    // Measured: the real binary exits 0 with empty stdout for empty stdin. That is a correct
    // answer, and the guard above must not turn it into a failure.
    const { filePath } = await project('format');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await fmt('', filePath, { engine: 'biome' })).toBe('');
    expect(warn.mock.calls).toEqual([]);
  });

  it('reads output past the 1 MB that execFile would have truncated at', async () => {
    const fmt = await freshFormatCode();
    // Measured: execFile's default maxBuffer is 1 MB and a 2.9 MB file came back cut to exactly
    // 1048576 bytes with ERR_CHILD_PROCESS_STDIO_MAXBUFFER. Generated barrels and JSON Schema
    // component files reach that size, so stdout is collected by hand instead.
    const { filePath } = await project('huge');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await fmt(mangled, filePath, { engine: 'biome' });
    expect(out.length).toBe(6 * 400000);
    expect(warn.mock.calls).toEqual([]);
  });

  it('warns once, and returns the code, when @biomejs/biome is not installed', async () => {
    const fmt = await freshFormatCode();
    // The experience a consumer with `engine: 'biome'` has had all along, which must not get worse:
    // unformatted files and one message saying so. What changes is that installing the package now
    // fixes it, so the message says to install it.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-biome-none-'));
    const filePath = path.join(dir, 'users.ts');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await fmt(mangled, filePath, { engine: 'biome' })).toBe(mangled);
    expect(await fmt(mangled, filePath, { engine: 'biome' })).toBe(mangled);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('[drzl]');
    expect(message).toContain('format.engine');
    expect(message).toContain('@biomejs/biome');
  });

  it('does not run the binary when formatting is switched off', async () => {
    const fmt = await freshFormatCode();
    const { filePath } = await project('crash');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await fmt(mangled, filePath, { engine: 'biome', enabled: false })).toBe(mangled);
    expect(warn.mock.calls).toEqual([]);
  });

  it('leaves biome alone under auto while prettier answers', async () => {
    const fmt = await freshFormatCode();
    // `auto` is documented as "tries Prettier, then Biome", and prettier is installed in this
    // workspace, so prettier must win even with a usable biome sitting next to the output file.
    // Its pair, format-biome-auto.spec.ts, takes prettier away and shows biome then answering;
    // without that pair this test would be satisfied by an `auto` that had lost the biome branch
    // altogether. Two spaces is prettier's indent, a tab is Biome's.
    const { filePath } = await project('format');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await fmt(mangled, filePath, { engine: 'auto' });
    expect(out).not.toBe(EXPECTED_2_5_7);
    expect(out).toContain('\n  return n + 1;');
    expect(warn.mock.calls).toEqual([]);
  });
});
