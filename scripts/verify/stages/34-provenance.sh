# ---------------------------------------------------------------------------------------------
# Does what npm actually serves carry a provenance attestation?
#
# The release workflow sets NPM_CONFIG_PROVENANCE and grants `id-token: write`, and both of those
# are statements of intent. The attestation is the result, it is produced by a different machine,
# and nothing looked at it. Losing it is silent in exactly the way this whole file exists for: the
# workflow still passes, the packages still publish, and the only difference is that npm stops
# showing where the tarball was built and `npm audit signatures` stops being able to answer.
#
# Measured 2026-08-03, over every version of every package: 203 published, 201 attested. The two
# without are @drzl/generator-json-schema@0.2.0 and @drzl/generator-typebox@0.0.0, and both are a
# package's very first version. That is not a workflow defect and it is not fixable: npm trusted
# publishing authenticates against a package that already exists, so the first version of a new
# name has to be published by hand and cannot carry provenance. Every version published by CI
# since has one.
#
# This asks about the version tagged `latest`, not about the version in this working tree, which
# during a release has not been published yet.
#
# The one exemption is load-bearing rather than tidiness. `pnpm verify:packed` runs as a step in
# release.yml *before* `changeset publish`, so a gate that failed on a package CI has never
# published would abort the job before the publish step, and the CI publish that is the only way
# to attest that package could never run. The repo would be one new package away from a release
# deadlock, and it added one in each of the last two releases.
#
# So the exemption is stated as what it actually needs to be: skip when *no* version of the
# package carries an attestation, which is exactly "CI has never published this". Counting
# versions instead is close but not the same thing, and the difference is a live deadlock shape:
# a package hand-published twice before CI takes over has two versions and no attestation, and
# the documented remediation for a broken release here is a hand publish, so it is the obvious
# way to arm it.
#
# The stronger form also detects more. `drizzle` has 33 versions and none attested, so CI has
# never published it and there is nothing to regress. `eslint-plugin-drizzle` has 251 versions of
# which 239 are attested and `latest` is not, which is a provenance setup that used to work and
# has stopped. Only the second is this gate's business, and a version count cannot tell them
# apart.
#
# Every error is a hard failure. An earlier draft skipped when the version lookup failed, which
# printed "this is a first publish" over a network error and exited 0.
# ---------------------------------------------------------------------------------------------
echo "==> published packages carry a provenance attestation"
names=$(node -e "
  const fs = require('fs');
  const out = [];
  for (const dir of fs.readdirSync('packages')) {
    const file = 'packages/' + dir + '/package.json';
    if (!fs.existsSync(file)) continue;
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!p.private) out.push(p.name);
  }
  process.stdout.write(out.join(' '));
")
if ! node "$HARNESS/check-provenance.mjs" "$(npm config get registry)" $names; then
  exit 1
fi
cd "$APP"
