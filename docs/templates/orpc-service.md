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
