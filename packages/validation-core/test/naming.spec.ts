import { describe, expect, it } from 'vitest';
import { pascalCase, resolveAffix, schemaName, typeName, validateAffix } from '../src';

const paths = (issues: { path: (string | number)[] }[]) => issues.map((i) => i.path.join('.'));

describe('@drzl/validation-core naming', () => {
  it('reproduces the pre-affix names when nothing is configured', () => {
    const r = resolveAffix();
    expect(schemaName('insert', 'users', r)).toBe('InsertusersSchema');
    expect(schemaName('update', 'users', r)).toBe('UpdateusersSchema');
    expect(schemaName('select', 'users', r)).toBe('SelectusersSchema');
    expect(typeName('insert', 'users', r)).toBe('InsertusersInput');
    expect(typeName('update', 'users', r)).toBe('UpdateusersInput');
    expect(typeName('select', 'users', r)).toBe('SelectusersOutput');
  });

  it('keeps the legacy schemaSuffix as the fallback for schema suffixes only', () => {
    const r = resolveAffix({ schemaSuffix: 'Validator' });
    expect(schemaName('insert', 'users', r)).toBe('InsertusersValidator');
    expect(schemaName('select', 'users', r)).toBe('SelectusersValidator');
    // Type aliases keep the hardcoded Input/Output the generators emit today.
    expect(typeName('insert', 'users', r)).toBe('InsertusersInput');
    expect(typeName('select', 'users', r)).toBe('SelectusersOutput');
  });

  it('lets affix.schema.suffix win over the legacy schemaSuffix', () => {
    const r = resolveAffix({ schemaSuffix: 'Validator', affix: { schema: { suffix: 'Doc' } } });
    expect(schemaName('insert', 'users', r)).toBe('InsertusersDoc');
  });

  it('accepts a flat string that applies to all three modes', () => {
    const r = resolveAffix({ affix: { type: { suffix: 'Dto' } } });
    expect(typeName('insert', 'users', r)).toBe('InsertusersDto');
    expect(typeName('update', 'users', r)).toBe('UpdateusersDto');
    expect(typeName('select', 'users', r)).toBe('SelectusersDto');
  });

  it('accepts a per-mode record and falls back to the default for absent modes', () => {
    const r = resolveAffix({ affix: { type: { prefix: { insert: 'Create', select: 'Get' } } } });
    expect(typeName('insert', 'users', r)).toBe('CreateusersInput');
    expect(typeName('update', 'users', r)).toBe('UpdateusersInput');
    expect(typeName('select', 'users', r)).toBe('GetusersOutput');
  });

  it('keeps schema and type affixes independent of one another', () => {
    const r = resolveAffix({ affix: { schema: { prefix: 'New' } } });
    expect(schemaName('insert', 'users', r)).toBe('NewusersSchema');
    expect(typeName('insert', 'users', r)).toBe('InsertusersInput');
  });

  it('upper-camels the drizzle export name under tableCase: pascal', () => {
    const r = resolveAffix({ affix: { tableCase: 'pascal' } });
    expect(schemaName('insert', 'users', r)).toBe('InsertUsersSchema');
    expect(schemaName('insert', 'userProfiles', r)).toBe('InsertUserProfilesSchema');
    expect(schemaName('insert', 'user_profiles', r)).toBe('InsertUserProfilesSchema');
    expect(typeName('select', 'userProfiles', r)).toBe('SelectUserProfilesOutput');
  });

  it('leaves the table token alone under the default tableCase: preserve', () => {
    const r = resolveAffix({ affix: { tableCase: 'preserve' } });
    expect(schemaName('insert', 'userProfiles', r)).toBe('InsertuserProfilesSchema');
  });

  it('pascalCase splits snake, kebab and camel boundaries without lowercasing acronyms', () => {
    expect(pascalCase('users')).toBe('Users');
    expect(pascalCase('userProfiles')).toBe('UserProfiles');
    expect(pascalCase('user_profiles')).toBe('UserProfiles');
    expect(pascalCase('user-profiles')).toBe('UserProfiles');
    expect(pascalCase('UserProfiles')).toBe('UserProfiles');
    expect(pascalCase('userID')).toBe('UserID');
    expect(pascalCase('')).toBe('');
  });

  it('allows an empty prefix and suffix so <Table> can be the plain type name', () => {
    const r = resolveAffix({
      affix: { tableCase: 'pascal', type: { prefix: { select: '' }, suffix: { select: '' } } },
    });
    expect(typeName('select', 'users', r)).toBe('Users');
    expect(typeName('insert', 'users', r)).toBe('InsertUsersInput');
    expect(
      validateAffix({
        tableCase: 'pascal',
        type: { prefix: { select: '' }, suffix: { select: '' } },
      })
    ).toEqual([]);
  });

  it('accepts every legacy configuration', () => {
    expect(validateAffix(undefined)).toEqual([]);
    expect(validateAffix(undefined, 'Validator')).toEqual([]);
    expect(validateAffix(undefined, '')).toEqual([]);
    expect(validateAffix({})).toEqual([]);
  });

  it('flags an affix that cannot appear inside an identifier', () => {
    expect(paths(validateAffix({ schema: { suffix: 'my-schema' } }))).toEqual(['schema.suffix']);
    expect(paths(validateAffix({ type: { prefix: { insert: '1st' } } }))).toEqual([
      'type.prefix.insert',
    ]);
    expect(paths(validateAffix({ schema: { prefix: 'a b' } }))).toEqual(['schema.prefix']);
  });

  it('allows a suffix that starts with a digit, since it never starts the identifier', () => {
    expect(validateAffix({ schema: { suffix: '2' } })).toEqual([]);
  });

  it('flags two schema names that collide in the same declaration space', () => {
    const issues = validateAffix({ schema: { prefix: '', suffix: '' } });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toMatch(/collide/i);
  });

  it('flags colliding type names', () => {
    const issues = validateAffix({ type: { prefix: 'The', suffix: '' } });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toMatch(/collide/i);
  });

  it('does not flag a schema name that equals a type name', () => {
    // `export const X` and `export type X` are different declaration spaces in TypeScript,
    // and the generators already emit `type X = z.input<typeof X>` style aliases.
    expect(validateAffix({ type: { suffix: 'Schema' } })).toEqual([]);
  });
});
