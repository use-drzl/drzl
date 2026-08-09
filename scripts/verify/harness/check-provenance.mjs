/**
 * One abbreviated packument per package, which is the only response that carries every version's
 * `dist.attestations` in a single request. `npm view` cannot answer this: a range resolves to one
 * version, so asking it per version would be one request per version, and one of the fixtures
 * this is reasoned about has 251 of them.
 */
const [registry, ...names] = process.argv.slice(2);
const base = registry.replace(/\/$/, '');
// The abbreviated document, roughly a third the size of the full one, and it carries `dist`.
const ACCEPT = 'application/vnd.npm.install-v1+json';

let bad = 0;
let notFound = 0;
/**
 * The positive control, and the thing that makes the exemption below safe to draw.
 *
 * `dist.attestations` being absent from a response is not the same observation as the package
 * having no attestation, and the difference decides the verdict: absent reads as "CI has never
 * published this", which is the branch that passes. A mirror configured as `registry` that drops
 * the field, or an abbreviated packument that stops carrying it, would put every package on that
 * branch and the stage would go green having measured nothing. `dist.attestations` is not in the
 * documented `dist` field set for the abbreviated document, so this is a shape npm is entitled to
 * change.
 *
 * So an absence is only allowed to mean anything once this run has seen the field present
 * somewhere. That is a positive observation that the source reports attestations at all.
 */
let attestedVersionsSeen = 0;
/** Verdicts deferred until the control above is known, so nothing prints a reason it cannot back. */
const exempt = [];
for (const name of names) {
  let doc;
  try {
    const res = await fetch(`${base}/${name.replace('/', '%2f')}`, { headers: { accept: ACCEPT } });
    if (res.status === 404) {
      notFound++;
      console.log(`    ${name} has no published version yet, so there is nothing to attest`);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    doc = await res.json();
  } catch (err) {
    // Never a skip. A registry that cannot be read is an unanswered question, not a pass.
    console.error(`    FAIL: could not read ${name} from ${base}: ${err.message}`);
    bad++;
    continue;
  }

  const latest = doc['dist-tags']?.latest;
  const versions = Object.keys(doc.versions ?? {});
  if (!latest || !doc.versions?.[latest]) {
    console.error(`    FAIL: ${name} has no version tagged latest, which npm should never serve.`);
    bad++;
    continue;
  }

  const attested = versions.filter((v) => doc.versions[v].dist?.attestations);
  attestedVersionsSeen += attested.length;
  const predicate = doc.versions[latest].dist?.attestations?.provenance?.predicateType;
  if (predicate) {
    console.log(`    ${name}@${latest}  ${predicate}`);
    continue;
  }
  if (attested.length === 0) {
    exempt.push({ name, latest, versions: versions.length });
    continue;
  }
  console.error(
    `    FAIL: ${name}@${latest} carries no provenance attestation, but ${attested.length} of ` +
      `its ${versions.length} versions do, so this package's provenance used to work and has ` +
      `stopped. Check that release.yml still sets NPM_CONFIG_PROVENANCE and still grants ` +
      `id-token: write, and that this version was published by CI rather than by hand.`
  );
  bad++;
}

// A registry pointed somewhere wrong answers 404 for everything, and every package would then
// take the "not published yet" line and the stage would pass having measured nothing. One
// unpublished package is ordinary; all of them is a broken registry.
if (names.length > 1 && notFound === names.length) {
  console.error(`    FAIL: ${base} answered 404 for all ${names.length} packages. That is a`);
  console.error('          registry pointed at the wrong place, not a workspace that has never');
  console.error('          published anything. Check `npm config get registry` and .npmrc.');
  bad++;
}

if (exempt.length && attestedVersionsSeen === 0) {
  // Nothing in this run carried the field, so "this package has no attestation" and "this source
  // does not report attestations" are the same observation and cannot be told apart. Neither is
  // a pass. Naming the packages matters: if they really are all awaiting a first CI publish, that
  // is the answer, and it needs a person rather than a default.
  console.error(`    FAIL: not one of the ${names.length} package(s) read from ${base} carried a`);
  console.error('          dist.attestations field on any version, so this run cannot tell a');
  console.error('          package that has never been published by CI from a registry that does');
  console.error('          not report attestations at all. Unattested here:');
  for (const e of exempt) console.error(`            ${e.name}@${e.latest} (${e.versions} version(s))`);
  console.error('          Check that `npm config get registry` is registry.npmjs.org and not a');
  console.error('          mirror, then confirm on the package page whether provenance is really');
  console.error('          absent.');
  bad++;
} else {
  for (const e of exempt) {
    console.log(
      `    ${e.name}@${e.latest} has no attestation, and neither does any of its ` +
        `${e.versions} version(s), so CI has never published it. npm trusted publishing ` +
        `cannot authenticate a name that has never existed, so the first publish is made by ` +
        `hand. Failing here would abort the release that would attest it. ` +
        `(${attestedVersionsSeen} attested version(s) seen elsewhere in this run, so the field ` +
        `is being reported.)`
    );
  }
}

if (bad) process.exit(1);
