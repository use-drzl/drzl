---
'@drzl/generator-orpc': minor
'@drzl/template-standard': minor
'@drzl/cli': patch
---

Generated oRPC routers now compile. They did not, with any built-in template, for as long as the
package has existed.

`create` and `update` declared `.output(SelectSchema)` and then returned the input. The input is
the *insert* shape, where generated and defaulted columns are optional, while select requires
them, so `tsc --strict` rejected every generated router: three errors on a two-table schema. It
went unnoticed because nothing ever compiled the output.

Returning the input was not merely mistyped, it was the wrong answer. A created row carries
generated columns the input never had, so no cast would have made it correct. Both stubs now
throw a `Not implemented` error naming the table and what to do. That satisfies the declared
contract, since a body which only throws has type `never`, and an unimplemented endpoint now
fails loudly instead of silently returning a malformed object.

`list`, `get` and `delete` are unchanged: `[]`, `null` and `true` are each a truthful value of
the declared output type. `@drzl/template-orpc-service` is also unchanged, because it delegates
to a service layer and already returns the select shape; the fix belongs in the stub templates,
not in the generator, which must never rewrite a real implementation.

**If you have generated routers and filled in the handlers, nothing changes.** If you were
relying on the stub bodies, `create` and `update` now throw rather than echoing the input back.

Also fixes `@drzl/cli` never passing `servicesDir` to the oRPC generator. The option is declared
on the generator and read by `@drzl/template-orpc-service`, which fell back to `src/services`
whatever the service generator was configured to use. Pairing that template with, say,
`{ kind: 'service', path: './src/api/services' }` emitted a router importing a module that was
never created. The CLI now passes the service generator's actual path.
