---
'@drzl/validation-core': patch
---

`format.engine: 'biome'` formats. It never has before.

`@biomejs/biome` publishes a `bin` and no module entry point at all, so the engine's
`import('@biomejs/biome')` rejected with `ERR_MODULE_NOT_FOUND` whether or not the package was
installed. Every project that configured biome got unformatted output, and after the previous
release, a warning telling them to run the CLI by hand.

It now spawns the binary the package actually publishes, found by resolving the package's own
manifest from the directory being generated into. Both `bin` shapes are handled: a string at 1.5.3
and below, an object from 1.9.4 on.

**What changes for you.** If you configured `engine: 'biome'` and installed `@biomejs/biome`, your
output is now formatted with it. If you configured it and did not install it, the warning now tells
you to install the package, which is advice that works, rather than pointing you at the CLI.
`engine: 'auto'` and `engine: 'prettier'` are unaffected.
