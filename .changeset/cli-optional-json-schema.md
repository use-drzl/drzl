---
'@drzl/cli': patch
---

Make `@drzl/generator-json-schema` an optional dependency, so the CLI installs again

`@drzl/cli@4.13.0` shipped with a hard dependency on `@drzl/generator-json-schema@^0.2.0`, and
that package failed to publish in the same release, so `npm install @drzl/cli` failed outright
with a 404 for everyone.

The publish failed because npm's trusted publishing has nothing to authenticate against for a
package name that has never existed: `E404 PUT /@drzl%2fgenerator-json-schema`. The account
disallows tokens, so the first version of any new package has to be published interactively before
CI can take it over. That is a one-time step and it had not been done.

An optional dependency that cannot be resolved is skipped rather than failing the install, so the
CLI installs and works as it did before, and the JSON Schema generator is picked up automatically
once it is on the registry. It is also the more honest declaration: the CLI imports every
generator dynamically and already reports a missing one with an install hint.
