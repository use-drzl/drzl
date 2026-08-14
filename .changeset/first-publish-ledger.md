---
---

Tell the nightly registry check the difference between a release that failed and a package nobody has published yet.

The check compares every package version on master against the registry and fails on any difference.
Both of these produce a difference and only one is a bug:

A release pull request merged by squash is authored by `github-actions[bot]`, so no workflow fires
and the versions never publish. That is the failure this job was written to catch.

A brand-new package has never been published at all, because npm trusted publishing cannot
authenticate a name that has never existed, so its first version is published by hand. Until someone
does, master carries a version the registry has never heard of. That is expected and it is not a bug.

From the outside they are the same observation, so the second one is now written down.
`scripts/awaiting-first-publish.json` lists the packages waiting on a first manual publish, and the
nightly reads it. The list is the same one `packages/cli/test/generator-registry.spec.ts` uses to
exempt those packages from being hard dependencies, moved into one file that both read, because two
copies of it in two languages would drift and the copy that drifted would be the one handing out
exemptions.

The exemption reports its own end. A listed package that the registry now serves fails the nightly,
naming the entry to delete and the promotion out of `optionalDependencies` it was standing in for.
Without that, the entry silently outlives the situation it described and hides the next real failure
for that package.

Two smaller things the same pass turned up.

A package absent from the registry and absent from the list now fails with its own message rather
than the squash-merge one, which was a confident and wrong diagnosis for that case.

`npm view` failing for any reason was read as "this package does not exist", so a network blip during
the nightly would report a healthy package as never published. Only a 404 means absent now; anything
else fails the run and says the registry could not be reached.

Finally, the job skipped private packages by comparing the output of `node -p` against `true`, and
`node -p` renders a boolean through `util.inspect`, which wraps it in colour escapes when it believes
stdout is a terminal. The comparison then never matched. No package in the repository is private
today, so nothing was being mis-reported, but the guard was not working and would have failed the
first private package added.
