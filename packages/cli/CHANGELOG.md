# @drzl/cli

## 0.3.0

### Minor Changes

- b2b8e35: fix(cli-config): improve watch and config loading

### Patch Changes

- @drzl/analyzer@0.3.0
- @drzl/generator-arktype@0.3.0
- @drzl/generator-orpc@0.3.0
- @drzl/generator-service@0.3.0
- @drzl/generator-valibot@0.3.0
- @drzl/generator-zod@0.3.0

## 0.2.0

### Minor Changes

- f007329: fix(cli): correct config types and update readme

### Patch Changes

- @drzl/analyzer@0.2.0
- @drzl/generator-arktype@0.2.0
- @drzl/generator-orpc@0.2.0
- @drzl/generator-service@0.2.0
- @drzl/generator-valibot@0.2.0
- @drzl/generator-zod@0.2.0

## 0.1.0

### Minor Changes

- 250f5fd: Ensure @drzl/cli builds and exports its config module so consumers can import it directly.

### Patch Changes

- @drzl/analyzer@0.1.0
- @drzl/generator-arktype@0.1.0
- @drzl/generator-orpc@0.1.0
- @drzl/generator-service@0.1.0
- @drzl/generator-valibot@0.1.0
- @drzl/generator-zod@0.1.0

## 0.0.3

### Patch Changes

- 4227090: Fix missing generator dependencies and improve error messages
  - Add all generator packages (@drzl/generator-zod, @drzl/generator-service, @drzl/generator-valibot, @drzl/generator-arktype) as dependencies in CLI package.json
  - Update error handling to provide clearer installation instructions when generators are missing
  - Separate error details for better readability

  This resolves the "Cannot find package" errors when using generators other than ORPC.
  - @drzl/analyzer@0.0.3
  - @drzl/generator-arktype@0.0.3
  - @drzl/generator-orpc@0.0.3
  - @drzl/generator-service@0.0.3
  - @drzl/generator-valibot@0.0.3
  - @drzl/generator-zod@0.0.3

## 0.0.2

### Patch Changes

- Fix missing generator dependencies and improve error messages
  - Add all generator packages (@drzl/generator-zod, @drzl/generator-service, @drzl/generator-valibot, @drzl/generator-arktype) as dependencies in CLI package.json
  - Update error handling to provide clearer installation instructions when generators are missing
  - Separate error details for better readability

  This resolves the "Cannot find package" errors when using generators other than ORPC.
  - @drzl/analyzer@0.0.2
  - @drzl/generator-arktype@0.0.2
  - @drzl/generator-orpc@0.0.2
  - @drzl/generator-service@0.0.2
  - @drzl/generator-valibot@0.0.2
  - @drzl/generator-zod@0.0.2

## 0.0.1

### Patch Changes

- 6130ad2: Initial public release setup: lockstep versioning, CI publish, and branding.
  - @drzl/analyzer@0.0.1
  - @drzl/generator-orpc@0.0.1
