/**
 * Every validation generator gets every option it supports.
 *
 * Each generator branch used to hand-build its own options object, and three documented options
 * were found silently dead as a result: `typedJson` never reached typebox, and `coerceDates` and
 * `applyDefaults` never reached anything but zod. The config parsed them and the CLI dropped them,
 * so the feature simply did nothing and nothing said so.
 *
 * One builder now serves all four, which removes the class rather than testing for each instance.
 * What remains per-generator is a capability: ArkType cannot reference a TypeScript type from
 * inside its string DSL, so the schema-import options are not passed to it.
 */
import { describe, it, expect } from 'vitest';
import { validationOptions } from '../src/validation-options';

const generator = {
  path: 'out',
  outputHeader: { enabled: true },
  format: { semi: false },
  schemaSuffix: 'Schema',
  fileSuffix: '.x.ts',
  importExtension: 'js' as const,
  affix: { tableCase: 'pascal' as const },
  coerceDates: 'none' as const,
  applyDefaults: true,
  typedJson: true,
  typedColumns: true,
  duplicateFinder: true,
  constraints: { errorMap: false },
  nestedSchemas: true,
  nestedDepth: 2,
  branded: { foreignKeys: false },
  meta: { description: true },
};
const config = { schema: 'src/db/schema.ts' };

describe('the shared options', () => {
  it('carries everything a generator can act on', () => {
    const o = validationOptions(generator, config, 'out', { schemaTypes: true });
    // Named individually rather than snapshotted, so adding an option to the config without
    // adding it here is a failing test rather than an updated snapshot.
    expect(o).toMatchObject({
      outDir: 'out',
      outputHeader: generator.outputHeader,
      format: generator.format,
      schemaSuffix: 'Schema',
      fileSuffix: '.x.ts',
      importExtension: 'js',
      affix: generator.affix,
      coerceDates: 'none',
      applyDefaults: true,
      schemaPath: 'src/db/schema.ts',
      typedJson: true,
      typedColumns: true,
      duplicateFinder: true,
      nestedSchemas: true,
      nestedDepth: 2,
      branded: { foreignKeys: false },
    });
  });

  it('carries branding to every generator, with no capability gate', () => {
    // Unlike `meta` and `standardSchema`, this one has no generator that cannot act on it.
    // TypeBox has no brand helper and still expresses the marker, through `TUnsafe`, so a
    // capability flag here would be a promise that one of the five does nothing.
    for (const caps of [{ schemaTypes: true }, { schemaTypes: false }, {}]) {
      expect(validationOptions(generator, config, 'out', caps).branded).toEqual({
        foreignKeys: false,
      });
    }
  });

  it('withholds the constraint ledger from the generators whose enforcement was not measured', () => {
    // The ledger states which constraints the emitted schemas enforce and the exact message each
    // uses. Measured on ArkType 2.2.3, neither claim holds there: it folds a cardinality check
    // into its own DSL, puts DRZL's wording in `expected` rather than `message`, and emits nothing
    // at all for a string `<>`. A flag is the honest record of where it was measured.
    expect(validationOptions(generator, config, 'out', { schemaTypes: true })).not.toHaveProperty(
      'constraints'
    );
    expect(
      validationOptions(generator, config, 'out', { schemaTypes: true, constraints: true })
    ).toMatchObject({ constraints: { errorMap: false } });
  });

  it('withholds metadata from the four generators that have no measured place to put it', () => {
    // zod is the only one that takes `meta` today. The other four each have a facility of their
    // own, and where the metadata has to attach in each is the whole difficulty; passing the
    // option to a generator that ignores it reads as a promise that something happened.
    expect(validationOptions(generator, config, 'out', { schemaTypes: true })).not.toHaveProperty(
      'meta'
    );
    expect(
      validationOptions(generator, config, 'out', { schemaTypes: true, meta: true })
    ).toMatchObject({ meta: { description: true } });
  });

  it('withholds the schema-import options from a generator that cannot use them', () => {
    // ArkType emits one string per field; a TypeScript type reference has nowhere to live there.
    // Passing them would be harmless but misleading, and the capability is the honest record.
    const o = validationOptions(generator, config, 'out', { schemaTypes: false });
    expect(o).not.toHaveProperty('schemaPath');
    expect(o).not.toHaveProperty('typedJson');
    expect(o).not.toHaveProperty('typedColumns');
    // Everything else still arrives.
    expect(o).toMatchObject({
      coerceDates: 'none',
      applyDefaults: true,
      affix: generator.affix,
      // Nesting is emitted from the analysis rather than from a type reference, so ArkType takes
      // it like the other three.
      nestedSchemas: true,
      nestedDepth: 2,
    });
  });

  it('defaults the output directory when the generator names none', () => {
    const o = validationOptions({}, config, 'src/validators/zod', {});
    expect(o.outDir).toBe('src/validators/zod');
  });
});
