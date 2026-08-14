# @drzl/generator-forms

## 0.2.1

### Patch Changes

- 555524a: Point the README documentation links at a host that resolves.

  Twelve package READMEs linked `https://drzl.dev/generators/<kind>`. That host does not resolve at
  all: curl fails to connect rather than returning a status. The site is published at
  `https://use-drzl.github.io/drzl/`, which every one of the twelve now uses, and each target was
  checked for a 200 before the link was rewritten.

  These are the READMEs npm renders on the package page, so the dead link was the "Full documentation"
  line a reader follows first. A version bump is the only way a corrected README reaches npm, which is
  why a link fix is a release.

  The split was along age: the twelve newest packages used `drzl.dev` and the ten older ones used the
  working form, so the wrong host was copied forward from one new package to the next.

  `@drzl/generator-ts-rest` also carries a version correction. Its source comments, the header it
  writes into every emitted contract, and its test docstring all said `@ts-rest/core` 3.53.0-rc.0 or
  newer, while `package.json` requires `^3.53.0-rc.1`. Both are now rc.1, which is the version the
  package actually pins and tests against. The distinction is real rather than cosmetic: 3.53.0-rc.0
  is published and does carry the Standard Schema support this generator depends on, exporting
  `isStandardSchema`, `validateAgainstStandardSchema` and `parseAsStandardSchema` and no
  `checkZodSchema`. Nothing here has been run against it, so the floor stays at the version the tests
  use and the test file now records why.

## 0.2.0

### Minor Changes

- d702af3: Add `@drzl/generator-forms`, which emits form resolvers and per-field input metadata for
  [react-hook-form](https://react-hook-form.com) and [TanStack Form](https://tanstack.com/form).

  ```ts
  generators: [
    { kind: 'zod', path: './src/validators/zod' },
    { kind: 'forms', path: './src/forms', target: 'react-hook-form' },
  ];
  ```

  **The two libraries want different things**, measured against `react-hook-form` 7.85.0,
  `@hookform/resolvers` 5.7.1 and `@tanstack/react-form` 1.33.5. react-hook-form needs a resolver, and
  `standardSchemaResolver` serves zod, valibot and arktype with one import while TypeBox and Effect
  have dedicated ones in the same package. TanStack Form needs none: a Standard Schema goes straight
  into `validators: { onChange: schema }`. Asking for the TanStack target with TypeBox or Effect is
  refused rather than emitted, because an options object naming a schema the form cannot read is
  silently ignored at runtime.

  **The field metadata is the half that is hard to get anywhere else**, and the reason it needed a new
  shared helper. `Column.min` and `Column.max` are the column's _type_ range and a `CHECK` does not
  narrow them: measured, a column with `check('adult', age >= 18)` still reports
  `min: '-2147483648'`. A form generator reading the column directly would put that on an input for a
  column the database restricts to 18, which is worse than emitting nothing, because it looks like a
  bound and the schema beside it would reject what the input accepted.

  So `fieldFacts` is added to `@drzl/validation-core`, beside `classifyTableChecks` and
  `tableConstraints`, performing the same fold every validation generator already does privately. The
  emitted `min` on an input and the emitted `.gte()` in the schema now come from one place.

  The same holds for length: `varchar(40)` with `CHECK (length(handle) <= 20)` reports
  `maxLength: 20`, and an unbounded `text` column with only a length check gets a `maxLength` its type
  never declared. A byte-count check is not read, because `octet_length` is not a character count and
  `maxlength` on an input counts characters.

  `select` is off by default: a select schema describes a row that came out of the database, so
  validating user input against it asks for the generated columns a form never supplies.

  `@drzl/generator-next` drops `forms` from its keywords. `package-metadata.spec.ts` refuses a package
  that describes itself with another package's name, and now that a dedicated forms generator exists,
  that term belongs to it.

  The package spends this release in `optionalDependencies` of `@drzl/cli`, as every new generator
  does.

  **`@hookform/resolvers` is capped at 5.4.0**, and that is measured rather than cautious. From 5.4.1
  it declares `@typeschema/main` as an _optional peer_, npm resolves optional peers, and that chain
  pins `zod ^3.23.8` and `valibot ^0.39.0`. DRZL emits zod 4 and valibot 1, so a plain `npm install`
  into a project carrying either fails outright:

  ```
  npm error Conflicting peer dependency: zod@3.25.76
  npm error   peerOptional zod@"^3.23.8" from @typeschema/zod@0.14.0
  npm error     peerOptional @typeschema/zod@"0.14.0" from @typeschema/main@0.14.1
  npm error       peerOptional @typeschema/main@">=0.13.7" from @hookform/resolvers@5.4.3
  ```

  Reproduced in the packed gate's consumer tree, which is a real `npm install` for exactly this kind
  of thing. 5.4.0 and earlier declare no `@typeschema` peer and install cleanly, and
  `standardSchemaResolver` has been there since 5.0.0, so the cap costs nothing. The generator's suite
  asserts it against the _installed_ copy rather than against the range string, so the day a release
  drops that peer the bound can move and a test says so.

  The consumer fixture's install also pins `valibot@^1.1.0` rather than leaving it bare. With no
  constraint npm was free to resolve valibot down to 0.39.0 to satisfy that optional peer, which then
  conflicted with `@drzl/generator-valibot`'s own `valibot >=1.0.0`. Stating the version the tree
  already requires stops npm solving the problem by going backwards.

### Patch Changes

- Updated dependencies [d702af3]
- Updated dependencies [331aa82]
- Updated dependencies [8a1798e]
  - @drzl/validation-core@3.23.0
  - @drzl/analyzer@1.22.0
