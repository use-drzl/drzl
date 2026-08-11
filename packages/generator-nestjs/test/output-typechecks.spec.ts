/**
 * The emitted tree compiles, with the real @nestjs/common and validator libraries installed.
 *
 * Three compilers look at it, because three different consumers will:
 *
 * 1. The exact tsconfig `scripts/verify-packed.sh` constructs for documented configs: `strict`,
 *    `es2022`, `nodenext`, `skipLibCheck`, and critically NO `experimentalDecorators` and no
 *    `emitDecoratorMetadata`. This is the load-bearing case of the whole design: a
 *    class-validator DTO fails TS1240 here (measured before this generator was written), and
 *    the plain-class output must not.
 * 2. The same flags plus `verbatimModuleSyntax`, the strictest import-elision setting a
 *    consumer can turn on.
 * 3. A real Nest app tsconfig, decorator flags on, compiling a controller that uses the DTOs
 *    the documented way. This is the consumer the docs page shows.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NestJSGenerator } from '../src';
import {
  activeUsers,
  analysis,
  auditLog,
  books,
  dailyTotals,
  events,
  memberships,
  posts,
  users,
} from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'typecheck');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');

/** Every table shape this generator has a branch for, compiled together. */
const tables = [users, posts, books, memberships, auditLog, activeUsers, dailyTotals, events];

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

/**
 * Emit into a directory under this package, so Node's resolver reaches the `@nestjs/common`,
 * `zod`, `valibot` and `arktype` this package installs. A temp directory elsewhere would
 * resolve nothing and the compile would prove nothing.
 */
async function compile(
  label: string,
  opts: Record<string, unknown>,
  extra = '',
  compilerExtras: Record<string, unknown> = {}
) {
  const dir = path.join(workRoot, label);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'api'), { recursive: true });
  await new NestJSGenerator(analysis(tables)).generate({
    outputDir: path.join(dir, 'api'),
    ...opts,
  } as never);
  if (extra) await fs.writeFile(path.join(dir, 'api', 'probe.ts'), extra);

  const tsconfig = path.join(dir, 'tsconfig.json');
  await fs.writeFile(
    tsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          target: 'es2022',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          skipLibCheck: true,
          ...compilerExtras,
        },
        include: ['api/**/*.ts'],
      },
      null,
      2
    )
  );
  // The generated `.js` specifiers only resolve under nodenext from a module package.
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"probe","type":"module"}');

  try {
    execFileSync(tsc, ['-p', tsconfig], { cwd: dir, stdio: 'pipe' });
    return '';
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    return `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`;
  }
}

describe('the emitted tree', () => {
  it('has a tsc to run', () => {
    // Without this the cases below would report an empty diagnostic list for a compiler that
    // never started, and pass on nothing at all.
    expect(existsSync(tsc), `no tsc at ${tsc}; run pnpm install`).toBe(true);
  });

  it('compiles under the exact tsconfig the packed-verification gate constructs', async () => {
    // No decorator flags anywhere. This is the case a class-validator emission cannot pass.
    expect(await compile('gate', {})).toBe('');
  });

  it('compiles under verbatimModuleSyntax too', async () => {
    expect(await compile('verbatim', {}, '', { verbatimModuleSyntax: true })).toBe('');
  });

  it('compiles in valibot mode', async () => {
    expect(await compile('valibot', { validation: { library: 'valibot' } })).toBe('');
  });

  it('compiles in arktype mode', async () => {
    expect(await compile('arktype', { validation: { library: 'arktype' } })).toBe('');
  });

  /**
   * The classes flow out of the barrel at their real member types: an enum column is its
   * members, not a bare string, or the literal below would not typecheck. The events entity
   * pins the wire decisions: `at` is a Date, `big` is a string, `prefs` is a json value rather
   * than `unknown`, and `blob` is real bytes on the read side however base64 arrived.
   */
  it('exports entity and DTO types a consumer can build values against', async () => {
    const probe = `import { CreateUsersDto, UsersEntity, EventsEntity } from './index.js';

const row: UsersEntity = { id: 1, email: 'a@b.c', bio: null, role: 'admin' };
const create: CreateUsersDto = { email: 'a@b.c', bio: null };
const event: EventsEntity = {
  id: 1,
  at: new Date(),
  flag: true,
  big: '9007199254740993',
  point: [1, 2],
  prefs: { nested: [1, 'two', null] },
  blob: new Uint8Array([1, 2, 3]),
  note: null,
};
export const values = [row, create, event] as const;
`;
    expect(await compile('classtype', {}, probe)).toBe('');
  });

  it('exports the schemas as values a consumer can reuse', async () => {
    const probe = `import { InsertusersSchema, UsersParamsSchema, SchemaValidationPipe } from './index.js';

export const things = [InsertusersSchema, UsersParamsSchema, new SchemaValidationPipe()] as const;
`;
    expect(await compile('schemas', {}, probe)).toBe('');
  });

  it('would have said so if the tree did not compile', async () => {
    // Every case above passes by producing no output, which a compiler that never ran also
    // does. So a mistake of exactly the shape this generator avoids is planted into a
    // compiling tree and has to be reported: the read-only table has no create DTO, so naming
    // one is an error.
    const probe = `import { CreateDailyTotalsDto } from './index.js';

export const dto = CreateDailyTotalsDto;
`;
    const out = await compile('canary', {}, probe);
    expect(out).not.toBe('');
    expect(out).toMatch(/probe\.ts/);
  });

  it('has no params DTO for a keyless table', async () => {
    const probe = `import { AuditLogParamsDto } from './index.js';

export const dto = AuditLogParamsDto;
`;
    const out = await compile('keyless-canary', {}, probe);
    expect(out).not.toBe('');
    expect(out).toMatch(/probe\.ts/);
  });

  it('rejects an enum member the column does not have', async () => {
    const probe = `import type { UsersEntity } from './index.js';

export const row: UsersEntity = { id: 1, email: 'a@b.c', bio: null, role: 'boss' };
`;
    const out = await compile('enum-canary', {}, probe);
    expect(out).not.toBe('');
    expect(out).toMatch(/probe\.ts/);
  });

  it('accepts an absent nullable field on the create DTO, and still demands the NOT NULL one', async () => {
    // The presence rule at the type level, both directions in one place. bio is nullable with no
    // default, so omitting it is a valid CreateUsersDto: the database accepts that INSERT and
    // stores NULL. email is NOT NULL with no default, so omitting it has to be an error, which is
    // what proves the clean compile above is the checker agreeing rather than the checker not
    // having run.
    const omitsNullable = `import type { CreateUsersDto } from './index.js';

export const create: CreateUsersDto = { email: 'a@b.c' };
`;
    expect(await compile('presence-canary', {}, omitsNullable)).toBe('');

    const omitsRequired = `import type { CreateUsersDto } from './index.js';

export const create: CreateUsersDto = { bio: null };
`;
    const out = await compile('presence-canary-required', {}, omitsRequired);
    expect(out).not.toBe('');
    expect(out).toMatch(/email/);
  });
});

describe('a consumer controller, compiled the way the docs show', () => {
  it('compiles with the standard Nest tsconfig flags', async () => {
    const probe = `import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { CreateUsersDto, UpdateUsersDto, UsersParamsDto, UsersEntity } from './index.js';

@Controller('users')
export class UsersController {
  @Post()
  create(@Body() body: CreateUsersDto): { email: string } {
    return { email: body.email };
  }

  @Patch(':id')
  update(@Param() params: UsersParamsDto, @Body() body: UpdateUsersDto): number {
    void body;
    return params.id;
  }

  @Get(':id')
  byId(@Param() params: UsersParamsDto): UsersEntity | null {
    void params;
    return null;
  }
}
`;
    expect(
      await compile('consumer', {}, probe, {
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      })
    ).toBe('');
  });
});
