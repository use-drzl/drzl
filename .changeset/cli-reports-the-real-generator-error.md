---
'@drzl/cli': patch
---

A generator that fails is reported as what went wrong, not as a missing package.

Every generator branch in the CLI except oRPC's wrapped `generate()` in a catch of one shape, so any
error at all came back as, for example, `Zod generator missing. Install with: npm install
@drzl/generator-zod`. The real reason was demoted to a trailing detail line, and the headline named a
package you already had installed. Ten places.

A module that cannot be resolved and a module that threw while running are now told apart, so a
genuinely absent optional generator still gets the install hint it is for, and a generator that
failed reports its own error.
