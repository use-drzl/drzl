---
'@drzl/generator-orpc': minor
---

`includeRelations` now also emits lookups that return another table: the inverse of a foreign
key, and the far side of a many-to-many.

```ts
// users router, because posts.authorId points here
listPosts: listPostsUsers,

// posts router, because posts and tags are joined by posts_to_tags
listTags: listTagsPosts,
```

The analyzer has reported both since 1.5.0, including `kind: 'manyToMany'` with the join table in
`via`. What was missing is that the output schema lives in another router file, and those imports
are circular the moment both directions exist, which many-to-many always does.

An eager reference typechecks perfectly and then throws `Cannot access SelecttagsSchema before
initialization` on the first import of the router. So the reference is deferred:

```ts
.output(z.array(z.lazy(() => SelecttagsSchema)))
```

`v.lazy` for Valibot. With `validation.useShared` every router imports the one barrel instead, so
no cycle arises, and the wrapper is harmless there.

ArkType is excluded. Its deferred form differs enough that emitting an untested shape would be
guessing, and an endpoint that fails to load is worse than one that is absent; its own
foreign-key lookups are unaffected.

`scripts/verify-packed.sh` now imports the generated router graph rather than only compiling it,
because this class of defect passes a typecheck and only fails at module initialisation.
