/**
 * A seeded pseudo-random generator, so a failing run can be replayed.
 *
 * mulberry32: 32 bits of state, one multiply-xorshift round. Chosen because it is short enough to
 * read and has no hidden state, which matters more here than statistical quality: the fuzzer needs
 * "the same seed picks the same tables" far more than it needs a good spectral test.
 *
 * `Math.random()` is deliberately never called anywhere in this directory. A finding nobody can
 * reproduce is a rumour.
 */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in [lo, hi]. */
export function int(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** One element of a non-empty array. */
export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** True with probability p. */
export function chance(rng, p) {
  return rng() < p;
}

/** A new array, Fisher-Yates shuffled. The input is not touched. */
export function shuffle(rng, arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * A seed from the clock, when the caller did not supply one.
 *
 * Printed by the CLI on every run, including the ones that find nothing, because the run that
 * finds something is never the one you thought to record.
 */
export function randomSeed() {
  return (Date.now() ^ (process.hrtime.bigint() & 0xffffffffn ? Number(process.hrtime.bigint() & 0xffffffffn) : 0)) >>> 0;
}
