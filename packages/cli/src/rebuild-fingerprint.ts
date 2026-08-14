import { createHash } from 'node:crypto';
import type { Analysis } from '@drzl/analyzer';

/**
 * Whether a watch rebuild would produce the same files as the last one.
 *
 * Every save re-runs every generator over every table, and that is most of what a rebuild costs.
 * Measured on this machine with a warm process: about 6.9 ms per table of generation on top of a
 * fixed cost, so a 60 table schema spends roughly 450 ms regenerating, and a larger one
 * proportionally more. Analysis itself is around 35 ms of that, which is why re-analysing on every
 * save is not the thing worth avoiding.
 *
 * Plenty of saves change nothing a generator reads. Adding a comment, reformatting, editing a
 * helper beside the tables, or typing a column name and deleting it again all re-trigger the
 * watcher and all produce byte-identical output. `EmitPlan` already declines to write an unchanged
 * file, so nothing lands on disk either way; what it does not avoid is *producing* the content to
 * compare, which is the expensive half.
 *
 * This is the cheap half of incremental watch and it is deliberately not the whole of it.
 * Regenerating only the tables that moved would need generators to accept a subset of the analysis
 * while still emitting a complete barrel, which is a change to the contract every generator
 * implements. Skipping a rebuild that would change nothing needs no such thing, and covers the case
 * that happens most while editing.
 */

/**
 * The fingerprint of everything a generator reads.
 *
 * `issues` is left out on purpose: a warning changes what `doctor` prints and never changes an
 * emitted file, so folding it in would make a rebuild that produced identical output look
 * different. Everything else the analysis carries is included, because a generator is free to read
 * it and leaving a field out is how this would silently skip a rebuild that mattered.
 */
export function analysisFingerprint(analysis: Analysis): string {
  const material = {
    dialect: analysis.dialect,
    tables: analysis.tables,
    enums: analysis.enums,
    relations: analysis.relations,
  };
  return createHash('sha256').update(stableStringify(material)).digest('hex');
}

/**
 * The fingerprint of the configuration a rebuild would generate under.
 *
 * The schema is not the only input. A config edit changes the output with the schema untouched, and
 * the watcher re-reads the config on every rebuild, so the two are hashed together and a change to
 * either is a rebuild.
 */
export function configFingerprint(generators: unknown): string {
  return createHash('sha256').update(stableStringify(generators)).digest('hex');
}

/**
 * JSON with object keys in a fixed order, so the same content hashes the same.
 *
 * `JSON.stringify` preserves insertion order, and the analyzer builds its objects by walking
 * drizzle's own structures, so two runs over an unchanged schema are not guaranteed to agree on key
 * order. Hashing the raw output would then report a change on a save that changed nothing, which is
 * exactly the false negative this is meant to avoid.
 *
 * `undefined` is dropped the way `JSON.stringify` drops it, so a field that is absent and one set to
 * `undefined` hash alike, which is how the analyzer spells "not applicable" in both places.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** What the watcher remembers between rebuilds. */
export interface RebuildSignature {
  analysis: string;
  config: string;
}

export function rebuildSignature(analysis: Analysis, generators: unknown): RebuildSignature {
  return { analysis: analysisFingerprint(analysis), config: configFingerprint(generators) };
}

/**
 * Whether this rebuild can be skipped.
 *
 * `undefined` means there has not been one yet, and the first build always runs: skipping it would
 * leave a watcher that started, printed its watch list and wrote nothing, which is a failure this
 * command has had before for a different reason.
 */
export function sameAsLast(
  previous: RebuildSignature | undefined,
  next: RebuildSignature
): boolean {
  if (!previous) return false;
  return previous.analysis === next.analysis && previous.config === next.config;
}
