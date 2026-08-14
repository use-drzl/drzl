---
'@drzl/cli': minor
---

The forms, openapi-fetch and pothos generators install with the CLI.

All three were `optionalDependencies` for one reason: npm trusted publishing cannot authenticate a
name that has never existed, so a brand-new package's first version is published by hand, and a hard
dependency on a name the registry does not have breaks `npm i @drzl/cli` for everyone. Declaring them
optional made the install skip them instead, and `drzl generate` printed the designed "not installed,
install with ..." line for those kinds rather than a stack trace.

All three are on the registry at 0.2.0 now, so the reason is gone and so is the exemption. They are
ordinary dependencies, which means `drzl generate` on those kinds works from a plain install rather
than only for someone who guessed they had to add the package themselves.

`scripts/awaiting-first-publish.json` keeps its rationale and its rules with an empty list, ready for
the next new package. Emptying it is what the two gates that read it were waiting for: while a
published package is still listed, the nightly fails naming the entry to delete, and the CLI registry
spec fails because a listed package must be optional. Both were red between the publish and this
change, which is the intended behaviour rather than a gap in it.
