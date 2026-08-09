import { SchemaAnalyzer } from '@drzl/analyzer';
import { ZodGenerator } from '@drzl/generator-zod';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const dir = await mkdtemp(path.join(process.cwd(), 'dupfinder-'));
await writeFile(
  path.join(dir, 'schema.ts'),
  [
    "import { pgTable, serial, text } from 'drizzle-orm/pg-core';",
    "export const skus = pgTable('skus', { code: text('code').primaryKey(), label: text('label') });",
    "export const audit = pgTable('audit', { id: serial('id').primaryKey(), note: text('note') });",
  ].join('\n')
);
process.chdir(dir);
const analysis = await new SchemaAnalyzer('schema.ts').analyze();
await new ZodGenerator(analysis).generate({ outDir: 'out', duplicateFinder: true });

const skusSrc = await readFile(path.join(dir, 'out', 'skus.zod.ts'), 'utf8');
if (!skusSrc.includes('export function findDuplicateskus')) {
  console.error('FAIL: no finder for a table whose only key is its primary key');
  process.exit(1);
}

const { createRequire } = await import('node:module');
const req = createRequire(import.meta.url);
const jiti = req('jiti')(import.meta.url, { moduleCache: false, interopDefault: true });
const skus = jiti(path.join(dir, 'out', 'skus.zod.ts'));
const audit = jiti(path.join(dir, 'out', 'audit.zod.ts'));

const collision = skus.findDuplicateskus([
  { code: 'A1', label: 'x' },
  { code: 'A1', label: 'y' },
]);
const expected = JSON.stringify([{ index: 1, constraint: 'skus_pkey', firstIndex: 0 }]);
if (JSON.stringify(collision) !== expected) {
  console.error('FAIL: explicit-key collision not reported, got', JSON.stringify(collision));
  process.exit(1);
}

const silent = audit.findDuplicateaudit([{ note: 'a' }, { note: 'a' }]);
if (silent.length !== 0) {
  console.error('FAIL: serial-omitting batch reported', JSON.stringify(silent));
  process.exit(1);
}

console.log('    finder covers the primary key: collision named skus_pkey, serial omission silent');
