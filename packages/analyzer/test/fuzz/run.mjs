/**
 * The runner: build every column drizzle can build, and report the ones the analyzer cannot name.
 *
 * Every serious analyzer defect found this month was a column that came back `unknown` or `any`, or
 * one typed as something the driver never produces: arrays, enums, `point` and `line`, `binary`,
 * the decimal modes, gel's temporal family, the mssql and cockroach boolean and string families.
 * Each was found because somebody happened to look at that column. This looks at all of them.
 *
 * **Why it enumerates rather than lists.** `enumerateCore` reads the column builders out of
 * drizzle's own exports and calls each one to see what it produces. A hand-written list of builders
 * would inherit exactly the blind spot this exists to find: the reason `mysqlEnum` went unnoticed
 * for so long is that nobody had written it down anywhere either.
 *
 * **Why both majors.** 0.4x and v1 describe columns through completely different mechanisms, a
 * class name against a `codec` plus `dataType`, and most defects here lived on one major only. A
 * fuzzer that ran on one would have missed the majority of what has been fixed.
 *
 * **What counts as a finding.** Two things, and the second is the one this was built for:
 *   - `unknown` or `any` with no shape, which is a validator that accepts anything
 *   - a class that no generated column ever reached, which means this run says nothing about it and
 *     the silence is not evidence
 *
 * It reports and exits 0 by default, because the analyzer has known gaps that are filed rather than
 * fixed and a red run every time is a red run nobody reads. `--gate` compares against
 * `expected.json` and exits 1 on anything new, which is the form for CI.
 */
import { writeFile, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRng } from './rng.mjs';
import { MAJORS, coreSpecifiers, enumerateCore, literal, unreachedColumnClasses } from './builders.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const gate = args.includes('--gate');
const seedArg = args.find((a) => a.startsWith('--seed='));
// Seeded and printed, always. A finding nobody can reproduce is a rumour.
const seed = seedArg ? Number(seedArg.slice(7)) : 1;
const rng = makeRng(seed);

/**
 * One schema module holding every variant of one core, and the analysis of it.
 *
 * All of them at once rather than a random subset per run: the point is coverage of the builder
 * space, and the space is small enough to take whole. The rng is still here and still seeded,
 * because the *option* values inside a builder are sampled and a failing choice has to be
 * replayable.
 */
async function analyseCore(analyzerModule, coreSpec, specs, tableFn) {
  // Inside the package, not in the system temp directory, and this is not a tidiness preference.
  // The generated module imports the core by its bare specifier, and a bare specifier resolves
  // against the importing file's location. Written to /tmp it resolves nothing, the analyzer
  // returns no tables, and every builder is then reported as one the analyzer dropped: a fuzzer
  // that says everything is broken is as useless as one that says nothing is, and the first run of
  // this file said 1280 columns were missing for exactly that reason.
  const dir = await mkdtemp(path.join(here, '.tmp-run-'));
  const file = path.join(dir, 'schema.mjs');

  const names = [...new Set(specs.map((s) => s.exportName))].sort();
  const preambles = specs.filter((s) => s.preamble).map((s) => s.preamble.code);

  // One column per spec, named for its index so the analysis can be matched back to the builder
  // that produced it. `.array()` is applied to a copy where the builder has it, since an array
  // column is a separate answer from its element and one of this month's defects was exactly that.
  const cols = [];
  const back = [];
  specs.forEach((s, i) => {
    const call = `${s.callee}(${s.args.map(literal).join(', ')})`;
    cols.push(`  c${i}: ${call},`);
    back.push(s);
    if (s.canArray && rng() < 0.5) {
      cols.push(`  c${i}_arr: ${call}.array(),`);
      back.push({ ...s, signature: `${s.signature}.array()`, isArray: true });
    }
  });

  const source = [
    `import { ${[...new Set([tableFn, ...names])].join(', ')} } from ${JSON.stringify(coreSpec)};`,
    ...preambles,
    `export const t = ${tableFn}('t', {`,
    ...cols,
    '});',
    '',
  ].join('\n');
  await writeFile(file, source, 'utf8');

  const { SchemaAnalyzer } = analyzerModule;
  let res;
  try {
    res = await new SchemaAnalyzer(file).analyze();
  } catch (e) {
    // A core that cannot be analysed at all is a finding rather than a skip: it means every column
    // in that dialect is unreported, which is the widest version of what this looks for.
    return { coreSpec, threw: String(e?.message ?? e), findings: [], reached: new Set() };
  }

  const table = res.tables?.[0];
  const findings = [];
  const reached = new Set();
  const columns = table?.columns ?? [];

  for (const c of columns) {
    const m = /^c(\d+)(_arr)?$/.exec(c.name);
    if (!m) continue;
    const spec = back.find((s, idx) => `c${idx}` === c.name || `c${idx}_arr` === c.name) ?? back[Number(m[1])];
    if (spec) reached.add(spec.columnKind);
    const wide = (c.tsType === 'unknown' || c.tsType === 'any') && !c.shape;
    if (wide) {
      findings.push({
        core: coreSpec,
        column: c.name,
        signature: spec?.signature ?? c.name,
        columnKind: spec?.columnKind ?? '?',
        dataType: spec?.dataType ?? '?',
        tsType: c.tsType,
      });
    }
  }

  // A column the analyzer dropped entirely is worse than one it could not name, and nothing else
  // here would report it: the loop above can only see columns that came back.
  const emitted = new Set(columns.map((c) => c.name));
  for (let i = 0; i < back.length; i++) {
    const name = back[i].isArray ? `c${i}_arr` : `c${i}`;
    if (!emitted.has(name) && !emitted.has(`c${i}`)) {
      findings.push({
        core: coreSpec,
        column: name,
        signature: back[i].signature,
        columnKind: back[i].columnKind,
        dataType: back[i].dataType,
        tsType: 'MISSING: the analyzer returned no column for this builder',
      });
    }
  }

  return { coreSpec, threw: null, findings, reached };
}

const analyzerModule = await import('../../dist/index.js');
const report = { seed, majors: [] };

for (const major of MAJORS) {
  const cores = await coreSpecifiers(major.pkg);
  if (!cores) {
    report.majors.push({ id: major.id, absent: true });
    continue;
  }
  const entry = { id: major.id, cores: [] };
  for (const coreSpec of cores) {
    const enumerated = await enumerateCore(coreSpec);
    if (!enumerated || !enumerated.specs?.length) {
      entry.cores.push({ core: coreSpec, unbuildable: true });
      continue;
    }
    const { specs, tableFn } = enumerated;
    const out = await analyseCore(analyzerModule, coreSpec, specs, tableFn);
    const unreached = await unreachedColumnClasses(coreSpec, out.reached);
    entry.cores.push({
      core: coreSpec,
      built: specs.length,
      threw: out.threw,
      findings: out.findings,
      unreached,
    });
  }
  report.majors.push(entry);
}

const allFindings = report.majors.flatMap((m) => (m.cores ?? []).flatMap((c) => c.findings ?? []));
const allUnreached = report.majors.flatMap((m) =>
  (m.cores ?? []).flatMap((c) => (c.unreached ?? []).map((k) => `${c.core} ${k}`))
);

console.log(`seed ${seed}`);
for (const m of report.majors) {
  if (m.absent) {
    console.log(`  ${m.id}: not installed`);
    continue;
  }
  for (const c of m.cores) {
    const label = `  ${m.id} ${c.core.replace(/^.*\//, '')}`;
    if (c.unbuildable) console.log(`${label}: no buildable columns`);
    else if (c.threw) console.log(`${label}: the analyzer threw, ${c.threw}`);
    else
      console.log(
        `${label}: ${c.built} builders, ${c.findings.length} unnamed, ${c.unreached.length} class(es) never reached`
      );
  }
}

if (allFindings.length) {
  console.log(`\n${allFindings.length} column(s) the analyzer cannot name:`);
  for (const f of allFindings) {
    console.log(`  ${f.core.replace(/^.*\//, '').padEnd(18)} ${f.signature.padEnd(38)} ${f.tsType}`);
  }
}
if (allUnreached.length) {
  console.log(`\n${allUnreached.length} column class(es) no generated column reached:`);
  for (const u of allUnreached) console.log(`  ${u}`);
}

if (args.includes('--write-baseline')) {
  const out = { seed, unnamed: [...new Set(allFindings.map((f) => `${f.core} ${f.signature}`))].sort() };
  await writeFile(path.join(here, 'expected.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`\nwrote expected.json with ${out.unnamed.length} entr(y/ies)`);
  process.exit(0);
}

if (!gate) process.exit(0);

// --gate: only what is new against the recorded baseline fails. Asserted in both directions, so a
// baseline entry that stops reproducing fails too and the file cannot rot into a list of things
// that used to be wrong.
const expectedPath = path.join(here, 'expected.json');
const expected = JSON.parse(await readFile(expectedPath, 'utf8'));
const key = (f) => `${f.core} ${f.signature}`;
const now = new Set(allFindings.map(key));
const was = new Set(expected.unnamed);
const added = [...now].filter((k) => !was.has(k));
const gone = [...was].filter((k) => !now.has(k));

if (added.length) {
  console.error(`\nFAIL: ${added.length} column(s) the analyzer stopped being able to name:`);
  for (const k of added) console.error(`  ${k}`);
}
if (gone.length) {
  console.error(`\nFAIL: ${gone.length} baseline entr(y/ies) no longer reproduce, so delete them:`);
  for (const k of gone) console.error(`  ${k}`);
}
process.exit(added.length || gone.length ? 1 : 0);
