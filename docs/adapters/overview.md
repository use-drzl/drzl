# Adapters (Overview)

DRZL is adapter‑agnostic. Router generation is driven by adapter templates so you can target different stacks.

Current support:

- oRPC adapter (via generator-orpc and related templates)

Planned/possible adapters (community interest welcome):

- tRPC, Express, NestJS, Next.js, Prisma, and more

How it works:

- Adapters define a small template interface (hooks) that tell the generator how to name files, export router identifiers, inject imports/prelude, and render procedure code.
- You can write custom templates to adapt to your runtime or conventions.

See also:

- [Router Adapters](/adapters/router)
- [Custom Templates](/templates/custom)
