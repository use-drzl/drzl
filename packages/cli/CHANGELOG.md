# @drzl/cli

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
