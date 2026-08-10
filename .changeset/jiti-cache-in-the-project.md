---
'@drzl/analyzer': patch
---

The transpiled schema is cached in the project, not wherever jiti happened to land

jiti caches a transpiled schema module in `node_modules/.cache/jiti` **if that directory already
exists**, and in `{TMP_DIR}/jiti` otherwise, resolved from the jiti instance's base. The base is the
analyzer module, which sits inside `node_modules/@drzl/analyzer/dist`, so which of the two a run got
depended on whether the consuming project happened to have a `node_modules/.cache` yet. Measured in
a project without one: the cache landed in `/tmp/jiti`, so clearing the project cache cleared
nothing and the following run was warm while reporting itself cold. That is a measurement hazard
before it is anything else, and it cost an earlier profiling session an hour of warm runs believed
to be cold.

It is now `node_modules/.cache/jiti` under the working directory, always, and only when the project
has a `node_modules` to put it in: a project without one is not handed a directory tree it did not
ask for, and jiti's own default takes over.

The cost being cached is worth knowing, since the cache is content-keyed and a saved schema is
therefore always a cold transpile. Measured on a 53 KB schema of 30 tables, in one long-lived
process, which is what `drzl watch` is:

```
first analysis                    70ms
again, file unchanged             10ms
after a save                     254ms
again, unchanged since that save   9ms
reverted to earlier content      134ms
```

The last row is the disk cache working: content seen before costs about half of content seen for the
first time, which is what makes its location worth pinning down. The third row answers whether
`watch` could hold a warm jiti instance across rebuilds and skip the cost. It could not. The cache
key is the content, the content is what changed, and transpiling it is what seeing the edit means.
