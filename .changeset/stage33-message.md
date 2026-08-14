---
---

Point the registry-dependency gate at the file that now holds the list.

When a package's first publish lands, the gate fails until the package is promoted out of the CLI's
`optionalDependencies`, and it prints the two edits to make. One of them named
`AWAITING_FIRST_PUBLISH` in `packages/cli/test/generator-registry.spec.ts`, which stopped being where
that list lives when it moved to `scripts/awaiting-first-publish.json` so the nightly could read it
too. The constant is still there and still called that, but it reads the JSON now, so the message
sent the reader to a file with nothing in it to edit.

Found by reading the gate's own output on its first real firing, after the three generator packages
were published by hand. The check itself was right, and every other reference to the old location is
a CHANGELOG entry describing what was true when it was written.
