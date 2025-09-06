/**
 * Custom Changesets commit message generator using Conventional Commits style.
 * Exports getAddMessage and getVersionMessage.
 */

/**
 * @param {import('@changesets/types').NewChangeset} changeset
 * @param {{ skipCI?: 'add'|'version'|true }} [options]
 */
async function getAddMessage(changeset, options) {
  const skipCI = options?.skipCI === 'add' || options?.skipCI === true;
  const skipMsg = skipCI ? '\n\n[skip ci]\n' : '';
  // Use chore for adding a changeset entry
  return `chore(changeset): ${changeset.summary}${skipMsg}`;
}

/**
 * @param {import('@changesets/types').ReleasePlan} releasePlan
 * @param {{ skipCI?: 'add'|'version'|true }} [options]
 */
async function getVersionMessage(releasePlan, options) {
  const skipCI = options?.skipCI === 'version' || options?.skipCI === true;
  const publishable = releasePlan.releases.filter(r => r.type !== 'none');
  const count = publishable.length;
  // If all packages share same version (lockstep), show that; otherwise list first few
  const versions = new Set(publishable.map(r => r.newVersion));
  const versionPart = versions.size === 1 ? `v${[...versions][0]}` : `${count} packages`;
  const lines = publishable
    .slice(0, 20)
    .map(r => `  - ${r.name}@${r.newVersion}`)
    .join('\n');
  const more = publishable.length > 20 ? `\n  - ...and ${publishable.length - 20} more` : '';
  const body = publishable.length ? `\n\nReleases:\n${lines}${more}` : '';
  return `chore(release): publish ${versionPart}${skipCI ? '\n\n[skip ci]\n' : ''}${body}`;
}

module.exports = {
  getAddMessage,
  getVersionMessage,
};

