---
'@drzl/validation-core': patch
---

A formatter named in `format.engine` that cannot be loaded is now reported, instead of producing
unformatted files and no message.

`format: { engine: 'prettier' }` with no prettier installed wrote every generated file exactly as
rendered and said nothing. The request was explicit, it did not happen, and there was no way to
tell from the run: unformatted output is still valid TypeScript, so nothing downstream fails
either. The same held for `format: { engine: 'biome' }`.

**What changes for you.** When `format.engine` names an engine and that engine cannot be loaded,
one line goes to stderr per run naming the setting, the package, what to do about it, and the
underlying error:

```
[drzl] format.engine is "prettier" but prettier could not be used, so the generated files were
left unformatted. Install prettier, which is an optional peer of @drzl/validation-core, or set
format.engine to "auto" to accept whatever formatter is present. Reason: Cannot find package
'prettier' imported from ...
```

It is a warning rather than an error. Generation still completes and the files are still written,
because the difference is whitespace and failing the run would trade a finished generation for it.
Once per run rather than once per file, since whether a formatter loads is a fact about the
environment and a forty-table schema would otherwise repeat it forty times.

**What does not change.** `format.engine: 'auto'`, the default, still falls back in silence: it
asked for whatever is installed, so finding nothing is an answer rather than a failure. Prettier is
still an optional peer that is never bundled, and `format: { enabled: false }` is still silent
because nothing was requested.
