# oRPC + Service Template

oRPC router template that connects procedures to the generated Service layer, with optional database injection middleware.

See the [package README](https://github.com/use-drzl/drzl/blob/master/packages/template-orpc-service/README.md) for hooks and options.

## Database middleware

When `databaseInjection.enabled` is true (configured via the oRPC generator), routers include a `dbMiddleware`:

```ts
import type { Database } from 'src/db/db';

export const dbMiddleware = os
  .$context<{ db?: Database }>()
  .middleware(async ({ context, next }) => {
    if (!context.db) throw new ORPCError('INTERNAL_SERVER_ERROR');
    return next({ context: { db: context.db } });
  });
```

Procedures call services with `context.db`.

## Key-typed handler bodies

Handler bodies are composed from the table's primary key, matching the signatures
`@drzl/generator-service` emits: one argument per key column, in key order.

```ts
// integer key
return await UserService.getById(input.id);
// natural key
return await BookService.getById(input.isbn);
// composite key
return await MembershipService.getById(input.orgId, input.userId);
return await MembershipService.update(input.orgId, input.userId, input.data);
```

A table with no primary key emits `list` and `create` only, because its service has nothing
else. A key column DRZL cannot type (for example `bigint`) arrives in the input schema as
`z.unknown()`, which the service's typed key parameter does not accept, so those procedures
throw with a note naming the column instead of emitting a call that does not compile.

## Example (Cloudflare D1)

```ts
import { RPCHandler } from '@orpc/server/fetch';
import { createDatabase } from 'src/db/db';
import { router } from 'src/api';

const handler = new RPCHandler(router);
export default {
  async fetch(request, env) {
    const db = createDatabase(env.DATABASE);
    return (
      (await handler.handle(request, { prefix: '/api', context: { db } })).response ??
      new Response('Not Found', { status: 404 })
    );
  },
};
```

::: tip Need something else?
If this template doesn't cover what you need, DM me on X (https://x.com/omardulaimidev) and we can scope it together.
:::
