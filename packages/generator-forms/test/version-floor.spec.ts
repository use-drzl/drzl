/**
 * The `@hookform/resolvers` range this generator's output can actually be installed with.
 *
 * Measured 2026-08-12 against the registry, and it is not caution about a number.
 * `@hookform/resolvers` declares `@typeschema/main` as an **optional peer** from 5.4.1 onward, and
 * npm resolves optional peers. That chain pins old validators:
 *
 *     @hookform/resolvers 5.4.3
 *       peerOptional @typeschema/main >=0.13.7
 *         peerOptional @typeschema/zod 0.14.0      -> peerOptional zod ^3.23.8
 *         peerOptional @typeschema/valibot 0.14.0  -> peerOptional valibot ^0.39.0
 *
 * DRZL's zod generator requires zod 4 and its valibot generator requires valibot 1, so `npm install`
 * into a project carrying either fails outright with ERESOLVE. Reproduced in the packed gate's
 * consumer tree, which is a real `npm install` for exactly this reason:
 *
 *     Conflicting peer dependency: zod@3.25.76
 *     peerOptional zod@"^3.23.8" from @typeschema/zod@0.14.0
 *
 * 5.4.0 and earlier declare no `@typeschema` peer and install cleanly beside zod 4 and valibot 1.
 * `standardSchemaResolver` is present from 5.0.0, so the range loses nothing this generator emits.
 *
 * These tests are the ledger. The day a release drops that optional peer, the upper bound can move
 * and this file says so rather than the range quietly staying tighter than it needs to be.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const manifest = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8')
) as { devDependencies: Record<string, string> };

describe('the @hookform/resolvers range', () => {
  it('is capped below the release that added the @typeschema optional peer', () => {
    expect(manifest.devDependencies['@hookform/resolvers']).toBe('>=5.0.0 <=5.4.0');
  });

  /**
   * MUST FIRE. The whole reason for the cap, asserted against the installed copy rather than
   * against the range above, which would only be checking the string against itself.
   */
  it('installs a copy that declares no @typeschema peer', async () => {
    const installed = JSON.parse(
      readFileSync(
        path.resolve(import.meta.dirname, '..', 'node_modules', '@hookform', 'resolvers', 'package.json'),
        'utf8'
      )
    ) as { version: string; peerDependencies?: Record<string, string> };
    const peers = Object.keys(installed.peerDependencies ?? {});
    expect(
      peers.filter((p) => p.startsWith('@typeschema/')),
      `@hookform/resolvers@${installed.version} pulls @typeschema, which pins zod 3 and valibot 0.39`
    ).toEqual([]);
  });

  it('still ships the Standard Schema resolver the range exists to keep', async () => {
    const m = await import('@hookform/resolvers/standard-schema');
    expect(typeof (m as { standardSchemaResolver?: unknown }).standardSchemaResolver).toBe('function');
  });
});
