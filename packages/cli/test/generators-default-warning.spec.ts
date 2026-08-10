/**
 * A config with no `generators` key writes an oRPC router tree, and now says so.
 *
 * The default is `[{ kind: 'orpc' }]`, so the smallest config that parses produces a whole API
 * surface: someone who came for validation schemas and wrote `{ schema: './db.ts' }` gets routers,
 * with nothing in the output naming where they came from.
 *
 * Said rather than changed. Both ways of removing the surprise, requiring the key or defaulting to
 * zod, change what an existing config does, and that belongs with a major. The silence does not
 * have to wait for one.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config';

async function warningsFor(config: Record<string, unknown>): Promise<string[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-gen-default-'));
  const file = path.join(dir, 'drzl.config.json');
  await fs.writeFile(file, JSON.stringify(config), 'utf8');
  const warnings: string[] = [];
  const cfg = await loadConfig(file, (w) => warnings.push(w));
  expect(cfg, 'the config did not load').not.toBeNull();
  await fs.rm(dir, { recursive: true, force: true });
  return warnings;
}

describe('the generators default', () => {
  it('is named when it applies, with the choices beside it', async () => {
    const warnings = await warningsFor({ schema: './db.ts' });
    const named = warnings.filter((w) => w.includes('no "generators" key'));
    expect(named, warnings.join('\n')).toHaveLength(1);
    // The choice it made, so a reader can tell what they are about to get.
    expect(named[0]).toContain("[{ kind: 'orpc' }]");
    // And enough of the alternatives to act on, rather than a bare complaint.
    for (const kind of ['zod', 'valibot', 'arktype', 'typebox', 'effect', 'json-schema']) {
      expect(named[0], kind).toContain(kind);
    }
  });

  it('says nothing when the key is written out, even to the same value', async () => {
    const warnings = await warningsFor({ schema: './db.ts', generators: [{ kind: 'orpc' }] });
    expect(warnings.filter((w) => w.includes('no "generators" key'))).toHaveLength(0);
  });

  it('still applies the default, since this is a warning and not a refusal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-gen-default-'));
    const file = path.join(dir, 'drzl.config.json');
    await fs.writeFile(file, JSON.stringify({ schema: './db.ts' }), 'utf8');
    const cfg = await loadConfig(file, () => {});
    expect(cfg?.generators).toEqual([expect.objectContaining({ kind: 'orpc' })]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
