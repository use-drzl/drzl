/**
 * What `drzl --version` reports, and what it does instead of reporting a wrong number.
 *
 * The CLI announced `0.0.1` for all 29 of its published versions, because `program.version()` was
 * handed that literal at scaffolding time and the manifest moved on without it. The bin test in
 * `every-entry-loads.spec.ts` ran the built binary the whole time and only asked whether anything
 * came out, which `0.0.1` satisfies; that assertion is now equality, and this file covers the
 * refusals, which running a correct build cannot reach.
 *
 * These load the source rather than `dist`, so they say nothing about the bundles. That is the
 * other file's job, and the packed artefact's.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCliVersion, readVersionFrom } from '../src/version';

const manifestPath = path.join(import.meta.dirname, '..', 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
  name: string;
  version: string;
};

/** A manifest written where `readVersionFrom` will be pointed at it. */
function manifestAt(body: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drzl-version-'));
  const file = path.join(dir, 'package.json');
  fs.writeFileSync(file, JSON.stringify(body), 'utf8');
  return file;
}

describe('readCliVersion', () => {
  it('reports the version in its own manifest', () => {
    expect(readCliVersion()).toBe(manifest.version);
  });

  it('does not report the scaffolded placeholder', () => {
    // Belt and braces on the assertion above: if @drzl/cli is ever legitimately at 0.0.1 again the
    // equality check would pass while the defect was back, and this is the version every report
    // that has ever been filed against this CLI carried.
    expect(manifest.version).not.toBe('0.0.1');
    expect(readCliVersion()).not.toBe('0.0.1');
  });
});

describe('readVersionFrom refuses rather than substituting', () => {
  it('throws when there is no manifest where one was expected', () => {
    const missing = path.join(os.tmpdir(), 'drzl-version-absent', 'package.json');
    expect(() => readVersionFrom(missing)).toThrow(/cannot read its own version/);
  });

  it('throws when the manifest it found belongs to some other package', () => {
    // The failure mode a bundler causes: the file resolves, so a read succeeds, and the number
    // that comes back is someone else's.
    const foreign = manifestAt({ name: 'not-drzl', version: '9.9.9' });
    expect(() => readVersionFrom(foreign)).toThrow(/found "not-drzl"/);
  });

  it('throws when the manifest declares no version', () => {
    const versionless = manifestAt({ name: manifest.name });
    expect(() => readVersionFrom(versionless)).toThrow(/declares no version/);
  });

  it('throws on an empty version rather than printing an empty line', () => {
    const blank = manifestAt({ name: manifest.name, version: '' });
    expect(() => readVersionFrom(blank)).toThrow(/declares no version/);
  });
});
