/**
 * A MySQL TEXT column is capped in bytes, and JSON Schema has no keyword for a byte length.
 *
 * The four validation generators encode the string and count the result. This one cannot: no
 * draft has a byte-length keyword, and inventing one would produce a document that validates as a
 * schema and means nothing, since an unknown keyword is not an error in JSON Schema, it is
 * ignored.
 *
 * What the format can say is `maxLength`, which counts characters. UTF-8 spends at least one byte
 * per character, so every string inside a byte budget is inside a character cap of the same
 * number: the cap emitted from `maxBytes` refuses nothing the column accepts, and it catches every
 * overflow made of one-byte characters, which is the ordinary one. What it cannot catch is a
 * multi-byte string that fits the character count and not the budget, and that is written into
 * `description` rather than left unsaid.
 *
 * Measured against a real MySQL 8 on utf8mb4 in STRICT_TRANS_TABLES, on `TINYTEXT`, whose budget
 * is 255 bytes. The emitted document is the one this generator produced from drizzle-orm 0.45.2
 * column objects, transpiled and imported, and read by ajv:
 *
 *   bytes  chars  MySQL     before    after
 *     255    255  accepts   accepts   accepts     255 ascii
 *     256    256  REFUSES   accepts   REFUSES     256 ascii
 *     254    127  accepts   accepts   accepts     127 e-acute
 *     256    128  REFUSES   accepts   accepts     128 e-acute
 *     255     85  accepts   accepts   accepts     85 cjk
 *     258     86  REFUSES   accepts   accepts     86 cjk
 *     252     63  accepts   accepts   accepts     63 emoji
 *     256     64  REFUSES   accepts   accepts     64 emoji
 *     800    200  REFUSES   accepts   accepts     200 emoji
 *
 * Four of those stay wrong, and they are the four a character count cannot see: a string can be
 * over the budget and under the count. Every one of them is over the budget by multi-byte text.
 *
 * The same 150 seeded random strings against the same server, before and after:
 *
 *   alphabet                 refused by MySQL and taken by the document   the other way
 *   mixed 1/2/3/4-byte       88 -> 68                                     0 -> 0
 *   one-byte characters      20 -> 0                                      0 -> 0
 *
 * `varchar(n)` is genuinely characters in the same database and keeps `maxLength` from its
 * declared length: the server took 10 emoji into a `varchar(10)` and refused 11.
 *
 * The column shape here is what `@drzl/analyzer` reports for a real `tinytext()` on drizzle-orm
 * 0.45.2, asserted in packages/analyzer/test/mysql-byte-caps.spec.ts: `maxBytes` set and
 * `maxLength` undefined.
 */
import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import { JsonSchemaGenerator, type JsonSchemaTarget } from '../src/index';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const col = (over: Partial<Column> = {}): Column =>
  ({
    name: 'n',
    tsType: 'string',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

let seq = 0;

/**
 * The emitted module, imported and read rather than matched against.
 *
 * The generator writes a `.ts` file holding the schema as data. Importing it is the only way to
 * be sure the thing a consumer installs carries the constraint, since a JSON Schema is data all
 * the way down and a keyword that never reached the file looks exactly like one that did until
 * something reads it.
 */
async function emitted(
  c: Column,
  opts: { target?: JsonSchemaTarget; checks?: { name?: string; expression?: string }[] } = {}
) {
  const table: Table = {
    name: 't',
    tsName: 't',
    columns: [c],
    unique: [],
    indexes: [],
    checks: opts.checks ?? [],
  } as never;
  const analysis: Analysis = {
    dialect: 'mysql',
    tables: [table],
    enums: [],
    relations: [],
    issues: [],
  } as never;
  const dir = path.join(__dirname, '.tmp-bytecaps');
  await fs.mkdir(dir, { recursive: true });
  await new JsonSchemaGenerator(analysis).generate({
    outDir: dir,
    ...(opts.target ? { target: opts.target } : {}),
  } as never);
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.schema.ts'), file);
  const mod = await import(file);
  return mod.SelecttSchema.properties.n as Record<string, unknown>;
}

/** Compiled in strict mode, so a keyword that does not exist fails here rather than being ignored. */
function compile(schema: unknown) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  return ajv.compile(schema as never);
}

const EMOJI = '\u{1F44D}'; // one code point, four bytes in UTF-8
const CJK = '好'; // one code point, three bytes
const ACUTE = 'é'; // one code point, two bytes

describe('a byte budget in a format with no byte-length keyword', () => {
  it('caps a column that carries only a byte budget, which is every TEXT column on 0.4x', async () => {
    // On drizzle-orm 0.4x a `tinytext` states no length at all, so `maxBytes` is the only cap the
    // column has. Ignoring it left `{ type: 'string' }`, which took a megabyte into a 255 byte
    // column. MySQL refuses 256 ascii with ERROR 1406, and so does official drizzle-zod 0.8.3.
    const v = compile(await emitted(col({ maxBytes: 255 })));
    expect(v('a'.repeat(255)), '255 bytes, which MySQL takes').toBe(true);
    expect(v('a'.repeat(256)), '256 bytes, which MySQL refuses').toBe(false);
  });

  it('refuses nothing the column accepts, whatever the text is made of', async () => {
    // The one direction that breaks working code. UTF-8 spends at least one byte per character,
    // so a character cap of the same number can never be the stricter of the two. Each of these
    // was accepted by a real MySQL 8 in the same run.
    const v = compile(await emitted(col({ maxBytes: 255 })));
    expect(v('a'.repeat(255)), '255 ascii, 255 bytes').toBe(true);
    expect(v(ACUTE.repeat(127)), '127 two-byte characters, 254 bytes').toBe(true);
    expect(v(CJK.repeat(85)), '85 three-byte characters, 255 bytes').toBe(true);
    expect(v(EMOJI.repeat(63)), '63 four-byte characters, 252 bytes').toBe(true);
  });

  it('says in prose what it cannot enforce, rather than pretending', async () => {
    // 64 emoji is 64 characters and 256 bytes: MySQL refuses the row and no character count can
    // say so. The schema takes it, and names the budget it cannot check.
    const s = await emitted(col({ maxBytes: 255 }));
    expect(String(s.description)).toContain('255 bytes');
    const v = compile(s);
    expect(v(EMOJI.repeat(64)), '256 bytes, and 64 characters, so the count cannot see it').toBe(
      true
    );
    expect(v(EMOJI.repeat(256)), '1024 bytes, and 256 characters, which it can').toBe(false);
  });

  it('keeps the smaller cap when a character limit is smaller', async () => {
    // A byte budget is not licence to widen a character limit: `varchar(10)` refuses an eleventh
    // character whatever it costs in bytes.
    const v = compile(await emitted(col({ maxLength: 10, maxBytes: 255 })));
    expect(v('a'.repeat(10))).toBe(true);
    expect(v('a'.repeat(11)), 'over the character limit').toBe(false);
  });

  it('is one cap when the two agree, which is the v1 shape of the same column', async () => {
    // v1's MySqlText states `length` equal to the type's budget, recorded in the 0.4x ledger in
    // scripts/verify-packed.sh, so on that major the column arrives carrying both. The emitted
    // document is the same one either way, which is the point: the two majors describe the same
    // column and now the two documents say the same thing about it.
    const s = await emitted(col({ maxLength: 255, maxBytes: 255 }));
    expect(s.maxLength).toBe(255);
    const v = compile(s);
    expect(v('a'.repeat(255))).toBe(true);
    expect(v('a'.repeat(256))).toBe(false);
  });

  it('narrows to a CHECK that is smaller still', async () => {
    const v = compile(
      await emitted(col({ maxBytes: 255 }), { checks: [{ expression: 'length(n) <= 100' }] })
    );
    expect(v('a'.repeat(100))).toBe(true);
    expect(v('a'.repeat(101))).toBe(false);
  });

  it('caps a base64 column at the encoded length, never at the byte count', async () => {
    // Not hypothetical: MYSQL_TEXT_CAPS covers the blob family too, and scripts/verify-packed.sh
    // records that on drizzle-orm 1.0.0-rc.4 a `tinyblob` column comes back carrying maxBytes
    // 255. Binary travels as base64, which is four characters for every three bytes, so a
    // character cap taken from a byte budget would refuse a full column: 255 bytes is 340 base64
    // characters. That is the one direction this must never take.
    //
    // The cap emitted is the *encoded* length, `4 * ceil(255 / 3)` = 340, which is the padded
    // length of a full column and an upper bound on the unpadded one. It refuses nothing the
    // column accepts and it does catch a payload too big to be one, which is more than the
    // keyword-free document said. See `octet-length.spec.ts` for the measurements.
    const s = await emitted(
      col({
        tsType: 'Uint8Array',
        dbType: 'BLOB',
        maxBytes: 255,
        shape: { kind: 'buffer' } as never,
      })
    );
    expect(s.maxLength, 'the encoded length, not the byte count').toBe(340);
    const v = compile(s);
    expect(v('A'.repeat(340)), 'a full 255 byte value, base64 encoded').toBe(true);
    expect(v('A'.repeat(344)), '258 bytes, which the column cannot hold').toBe(false);
    expect(String(s.description)).toContain('At most 255 bytes');
  });

  it('carries the cap into the OpenAPI 3.0 spelling too', async () => {
    // `maxLength` and `description` mean the same thing in 3.0, so nothing changes but the draft.
    const s = await emitted(col({ maxBytes: 255 }), { target: 'openapi-3.0' });
    expect(s.maxLength).toBe(255);
    expect(String(s.description)).toContain('255 bytes');
  });
});
