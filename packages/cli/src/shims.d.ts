/**
 * Ambient declarations for packages that ship no types of their own.
 *
 * Only that. This file used to declare all twenty-five `@drzl/generator-*` packages as `any` too,
 * and an ambient `declare module` beats a package's real `.d.ts`, so every generator call in this
 * CLI typechecked as `any`: wrong argument counts, wrong shapes and renamed exports all passed.
 * Measured by putting a deliberately wrong call behind `@ts-expect-error`, which tsc reported as
 * unused while the shims were present and honoured once they were gone.
 *
 * So: nothing that has its own types belongs here.
 */
declare module 'cli-progress' {
  const cliProgress: any;
  export default cliProgress;
}
