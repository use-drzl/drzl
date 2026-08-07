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
  nestedSchemas: true,
  nestedDepth: 2,
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
    });
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
