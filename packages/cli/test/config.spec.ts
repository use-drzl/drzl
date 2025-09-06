import { describe, it, expect } from 'vitest';
import { loadConfig, defineConfig } from '../src/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('@drzl/cli config', () => {
  it('defineConfig returns shape', () => {
    const cfg = defineConfig({
      schema: 'x',
      generators: [{ kind: 'orpc' }],
      outDir: 'out',
      analyzer: { includeRelations: true, validateConstraints: true },
    } as any);
    expect(cfg.schema).toBe('x');
  });

  it('loadConfig reads JSON and applies defaults', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-cli-'));
    const tmp = path.join(tmpDir, 'tmp.config.json');
    try {
      await fs.writeFile(
        tmp,
        JSON.stringify({ schema: 'x', generators: [{ kind: 'orpc' }] }),
        'utf8'
      );
      const cfg = await loadConfig(tmp);
      expect(cfg?.analyzer?.includeRelations).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
