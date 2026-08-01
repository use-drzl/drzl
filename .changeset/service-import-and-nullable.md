---
'@drzl/template-orpc-service': minor
'@drzl/generator-service': minor
'@drzl/generator-orpc': patch
---

Two defects in generated output that stopped it resolving or typechecking, both found by running
the published packages rather than the workspace.

**The service import was not a usable specifier.** `@drzl/template-orpc-service` built it by
hand and got two things wrong at once:

    import { PostService } from "services/postService";       // before
    import { PostService } from "./services/postService.js";  // after

`path.relative` returns a bare `services` whenever the services directory sits inside the
router's output directory, and a specifier without a leading `./` is a *bare* specifier: Node
looks for a package of that name in node_modules and never considers the file next door. It also
carried no extension, making it the one relative import DRZL emitted that failed under
`moduleResolution: node16` and `nodenext`, despite 2.0.0 stating that every relative specifier
now ends in `.js`. It goes through `importSpecifier` now, the same helper the router barrel uses,
so it honours `importExtension` like everything else. `@drzl/generator-orpc` also now passes
`importExtension` into the template context, which it previously had no way to see.

**Service types rejected `null` for nullable columns.** A nullable column was emitted as
optional, which admits `undefined` and not `null`:

    balance?: number          // before
    balance: number | null    // after, in Select
    balance?: number | null   // after, in Insert and Update

Optional and nullable are different: `foo?: T` means the key may be absent, `foo: T | null` means
it is present and may be null. So a row read back with a real `null` did not match `Select`, and
passing `null` to update was a type error, while the validation generators emitted
`z.number().nullable()` for the same column. Both halves of one generated project disagreed about
the same database. `Select` no longer marks anything optional either: a row read back carries
every column, whatever its default.

Both were invisible because `scripts/verify-packed.sh` ran the oRPC generator with the default
template, which imports nothing DRZL generated and never touches the service types. It now uses
`@drzl/template-orpc-service`, so every generated module is imported and typechecked by another.
