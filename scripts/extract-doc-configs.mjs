/**
 * Pull every runnable DRZL config out of the docs.
 *
 * Two rounds of defects were "the documentation shows a config that does not work": the
 * getting-started guide emitted three imports that resolved to nothing, and validation-mix.md
 * carried the same shape. Both were found by hand. Anything a reader can copy should be run.
 *
 * Only blocks that a reader could actually copy and run are emitted:
 *
 *   - a fenced `ts` block containing `generators:`
 *   - with `export default`, so it is a whole config rather than a fragment
 *   - and a `schema:` key, so there is something to point the analyzer at
 *
 * Fragments illustrating one option are deliberately skipped. There is nothing to run, and
 * inventing the missing half would test this script rather than the documentation.
 *
 * Prints JSON to stdout: [{ file, line, schema, outDir, config }]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const docsDir = process.argv[2];
if (!docsDir) {
  console.error('usage: extract-doc-configs.mjs <docs-dir>');
  process.exit(2);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

const configs = [];

for (const file of walk(docsDir).sort()) {
  const source = readFileSync(file, 'utf8');
  const fence = /```ts\n([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(source))) {
    const block = m[1];
    if (!block.includes('generators:')) continue;
    if (!block.includes('export default')) continue;

    const schema = block.match(/schema:\s*['"]([^'"]+)['"]/)?.[1];
    if (!schema) continue;

    configs.push({
      file: path.relative(docsDir, file),
      line: source.slice(0, m.index).split('\n').length,
      schema,
      outDir: block.match(/outDir:\s*['"]([^'"]+)['"]/)?.[1] ?? 'src/api',
      config: block,
    });
  }
}

process.stdout.write(JSON.stringify(configs, null, 2));
