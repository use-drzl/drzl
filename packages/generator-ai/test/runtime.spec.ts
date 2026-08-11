/**
 * The emitted tools are validated through the AI SDK's own machinery.
 *
 * Everything this generator claims is a claim about what a model is told and what it is allowed to
 * send, and none of it is visible in the text: whether a bound survives the conversion into the
 * JSON Schema the provider receives, whether an out-of-range argument is refused before `execute`
 * runs, and above all whether the refusal happens at all.
 *
 * That last one is not hypothetical for one of the three libraries. The SDK's Standard Schema
 * adapter decides a validation passed with `'value' in result`, and a valibot failure result is
 * `{ value, typed, issues }`, so every valibot failure reads as a success and the invalid input
 * reaches `execute`. A generated valibot tool that validated nothing would look identical to one
 * that worked, in the emitted text and in a type check. Only this file can tell them apart, and
 * the case named for it below is the reason the valibot dialect emits an adapter rather than
 * handing the schema over.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { asSchema, safeValidateTypes } from '@ai-sdk/provider-utils';
import { AIGenerator } from '../src';
import { analysis, auditLog, books, dailyTotals, events, memberships, products, users } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');

type Lib = 'zod' | 'valibot' | 'arktype';
const TABLES = [users, products, books, memberships, auditLog, dailyTotals, events];

interface Tools {
  [name: string]: { description?: string; inputSchema: unknown; execute: (i: unknown) => unknown };
}

async function build(lib: Lib): Promise<Tools> {
  const out = path.join(pkgRoot, 'test', 'tmp', 'runtime', lib);
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  await new AIGenerator(analysis(TABLES)).generate({
    outputDir: path.relative(process.cwd(), out),
    importExtension: 'none',
    validation: { library: lib },
  });
  const mod = await import(pathToFileURL(path.join(out, 'index.ts')).href);
  return mod.allTools as Tools;
}

/** The JSON Schema a provider is sent for one tool, which is what the model reads. */
async function schemaOf(tools: Tools, name: string): Promise<Record<string, any>> {
  const t = tools[name];
  expect(t, `no tool named ${name} in ${Object.keys(tools).join(', ')}`).toBeTruthy();
  return (await asSchema(t.inputSchema as never).jsonSchema) as Record<string, any>;
}

/** Whether the SDK lets a value through to `execute`. */
async function accepts(tools: Tools, name: string, value: unknown): Promise<boolean> {
  const r = await safeValidateTypes({ value, schema: asSchema(tools[name].inputSchema as never) });
  return r.success;
}

describe.each(['zod', 'valibot', 'arktype'] as const)('a generated tool set (%s)', (lib) => {
  let tools: Tools;
  beforeAll(async () => {
    tools = await build(lib);
  }, 30_000);

  it('exposes five tools for a writable table with a key', () => {
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining([
        'users_list',
        'users_get',
        'users_create',
        'users_update',
        'users_delete',
      ])
    );
  });

  it('gives a read-only table no write tools', () => {
    const daily = Object.keys(tools).filter((n) => n.startsWith('daily_totals_'));
    expect(daily).toEqual(['daily_totals_list']);
  });

  it('advertises the arguments of every tool rather than an empty object', async () => {
    const schema = await schemaOf(tools, 'users_create');
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(['email', 'bio', 'seenAt'])
    );
  });

  it('carries the page-size bounds into the schema the model reads', async () => {
    const schema = await schemaOf(tools, 'users_list');
    expect(schema.properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 200 });
  });

  /**
   * The case the valibot adapter exists for.
   *
   * Handed over as a plain Standard Schema, a valibot tool accepts this. Measured against ai 7.0.59
   * and @ai-sdk/provider-utils 5.0.26 on 2026-08-11, and asserted for all three libraries here
   * because the point is that they agree.
   */
  it('refuses an out-of-range argument before execute runs', async () => {
    expect(await accepts(tools, 'users_list', { limit: 5000 })).toBe(false);
    expect(await accepts(tools, 'users_list', { limit: 10 })).toBe(true);
  });

  it('refuses a wrong type before execute runs', async () => {
    expect(await accepts(tools, 'users_get', { id: 'one' })).toBe(false);
    expect(await accepts(tools, 'users_get', { id: 1 })).toBe(true);
  });

  it('refuses a missing required column', async () => {
    expect(await accepts(tools, 'users_create', {})).toBe(false);
  });

  it('refuses half a composite key', async () => {
    expect(await accepts(tools, 'memberships_get', { orgId: 1 })).toBe(false);
    expect(await accepts(tools, 'memberships_get', { orgId: 1, userId: 2 })).toBe(true);
  });

  it('takes a numeric key as a number, not as a string', async () => {
    const schema = await schemaOf(tools, 'users_get');
    expect(schema.properties.id).toMatchObject({ type: 'number' });
  });

  it('takes a date column as a string', async () => {
    const schema = await schemaOf(tools, 'users_create');
    expect(JSON.stringify(schema.properties.seenAt)).toContain('"string"');
    expect(await accepts(tools, 'users_create', { email: 'a@b.c', seenAt: 'not a date' })).toBe(
      false
    );
  });

  it('names the CHECK constraints a schema cannot express', () => {
    expect(tools['products_create'].description).toContain('price > cost');
  });

  it('reaches execute once the arguments are valid', async () => {
    await expect(
      Promise.resolve(tools['users_create'].execute({ email: 'a@b.c' }))
    ).rejects.toThrow(/Not implemented: create users/);
  });

  it('runs a read tool and gets an empty result rather than a throw', async () => {
    await expect(Promise.resolve(tools['users_list'].execute({ limit: 10, offset: 0 }))).resolves.toEqual(
      []
    );
  });
});

describe('the valibot adapter, against what handing the schema over would do', () => {
  /**
   * The must-fire half.
   *
   * Without this the case above passes for a generator that does nothing special, because a
   * library that already worked looks identical. This asserts the defect is real: the same schema
   * handed to the SDK as a Standard Schema accepts a value it refuses when asked directly.
   */
  it('is what makes a valibot bound refuse anything at all', async () => {
    const v = await import('valibot');
    const schema = v.object({ age: v.pipe(v.number(), v.integer(), v.minValue(18)) });
    const bad = { age: 7 };

    // valibot itself is in no doubt.
    expect(v.safeParse(schema, bad).success).toBe(false);

    // The SDK, handed the same schema as a Standard Schema, is.
    const through = await safeValidateTypes({ value: bad, schema: asSchema(schema as never) });
    expect(through.success, 'the SDK refused it, so the adapter is no longer needed').toBe(true);

    // And the emitted tools do not do that.
    const tools = await build('valibot');
    expect(await accepts(tools, 'users_list', { limit: 5000 })).toBe(false);
  }, 30_000);

  it('leaves zod and arktype alone, because neither needs it', async () => {
    for (const lib of ['zod', 'arktype'] as const) {
      const out = path.join(pkgRoot, 'test', 'tmp', 'runtime', lib);
      const text = await fs.readFile(path.join(out, 'users.ts'), 'utf8');
      expect(text, lib).not.toContain('drzlValibotTool');
    }
    const valibot = await fs.readFile(
      path.join(pkgRoot, 'test', 'tmp', 'runtime', 'valibot', 'users.ts'),
      'utf8'
    );
    expect(valibot).toContain('drzlValibotTool');
  });
});
