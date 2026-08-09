# OpenAPI Document

The [JSON Schema generator](/generators/json-schema) already emits `components.schemas`. This emits
the rest of the document around them: a path per table, the verbs on each, which schema backs each
request and response body, and what comes back when a schema does its job and refuses a request.

```ts
{ kind: 'json-schema', target: 'openapi-3.1', document: true }
```

That writes `openapi.ts` beside the per-table modules, exporting one `as const` object. Everything
is inlined, so the file stands alone and needs no `components: true` beside it.

## Where this lives, and why it is not its own package

It is a mode of `@drzl/generator-json-schema` rather than a new `kind`, because the document and the
schemas inside it have to agree about which dialect they are written in. `target: 'openapi-3.0'`
changes how a nullable column, an exclusive bound and a pinned value are all spelled; a separate
generator holding its own copy of that setting could be configured to emit 3.1 schemas inside a 3.0
document, and the result validates as OpenAPI and then means something else.

## The path set

Two paths per table:

| Path          | Verb     | Request body  | Success                          |
| ------------- | -------- | ------------- | -------------------------------- |
| `/users`      | `GET`    | none          | `200`, an array of `usersSelect` |
| `/users`      | `POST`   | `usersInsert` | `201`, one `usersSelect`         |
| `/users/{id}` | `GET`    | none          | `200`, one `usersSelect`         |
| `/users/{id}` | `PATCH`  | `usersUpdate` | `200`, one `usersSelect`         |
| `/users/{id}` | `DELETE` | none          | `204`, no body                   |

The resource is named after the **database** table name, the same name `include` and `exclude` in
your config already match against. Two tables that would claim one path are refused with an error
naming both, rather than one silently overwriting the other.

No pagination parameters are emitted. Whether the server implements a limit, an offset or a cursor
is not something a Drizzle schema states, and a declared parameter that nothing honours is worse
than an undeclared one.

### The key is read, never invented

The path parameter is the table's real primary key, every column of it, at its real type.

```ts
// sessions, keyed by a uuid column called `token`
'/sessions/{token}': {
  parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
}
```

| The table's key             | What is emitted                                                 |
| --------------------------- | --------------------------------------------------------------- |
| `id serial primary key`     | `/users/{id}`, `{ type: 'integer' }`                            |
| `token uuid primary key`    | `/sessions/{token}`, `{ type: 'string', format: 'uuid' }`       |
| `primaryKey(orgId, userId)` | `/org_members/{orgId}/{userId}`, one parameter each             |
| no primary key              | `/events` and nothing else. No `GET`, `PATCH` or `DELETE` by id |

This follows [the tRPC generator](/generators/trpc), which reads the real key and drops the
procedures that would have needed one, rather than [the oRPC generator](/generators/orpc), which
emits `z.object({ id: z.number() })` for every table whatever its key is. The case for reading it is
stronger in a document than in a router: a tRPC client is typechecked against the router it calls,
so a fictional `id` is at least caught at build time, while an OpenAPI document is read by code
generators in other languages that have nothing at all to check it against.

A table with no primary key still gets `GET /events` and `POST /events`: inserting a row does not
require being able to address one afterwards. Its tag says why the rest is missing.

A table the database refuses to write, which today means a materialized view, gets only the two
`GET`s, and its insert and update schemas are not carried at all.

## Status codes

| Code  | Where                                                | Why                            |
| ----- | ---------------------------------------------------- | ------------------------------ |
| `200` | `GET`, `PATCH`                                       | The row, or the rows           |
| `201` | `POST`                                               | The row that was created       |
| `204` | `DELETE`                                             | See below                      |
| `400` | Everything that takes a body or a path parameter     | The schema refused the request |
| `404` | Everything under `/{key}`                            | No row has that key            |
| `409` | `POST`, and `PATCH` where a unique constraint exists | Named in the description       |

**`DELETE` returns `204` and no body.** Handing back the deleted row is the obvious alternative and
it is not a true statement on every dialect DRZL supports: `RETURNING` is Postgres and SQLite, and
MySQL has no such clause, so an implementation there would have nothing to send.

**The validation failure is `400` by default.** A schema that refuses a body is only half a
contract; the document has to say what the server sends back when it does. RFC 9110 gives `422` to a
request the server understood and could not process, which is arguably the closer reading, and the
ecosystem is genuinely split, so it is one option and exactly one code is emitted:

```ts
{ kind: 'json-schema', document: { validationStatus: 422 } }
```

**`409` names the constraint it is about.** Uniqueness is the one thing a per-row schema
structurally cannot state, because it is a fact about the table rather than about the row, so the
document is where it gets said:

```json
{
  "description": "The row collides with an existing one on primary key (id); users_email_key (email)."
}
```

It is on `PATCH` only where a unique constraint over non-key columns exists, since the primary key
is not in the update schema and a patch cannot collide on it.

Every error response points at one `Error` schema, which is deliberately open so an implementation
can add fields without contradicting the document.

## 3.1 and 3.0

The `target` you already set on the generator decides both the document version and the dialect the
schemas inside it are written in.

| `target`                  | `openapi:` | Schemas                         |
| ------------------------- | ---------- | ------------------------------- |
| `draft-2020-12` (default) | `3.1.1`    | 2020-12, with `$schema` dropped |
| `openapi-3.1`             | `3.1.1`    | the same                        |
| `openapi-3.0`             | `3.0.3`    | the 3.0 dialect                 |

`draft-2020-12` and `openapi-3.1` differ only by the `$schema` declaration, which a schema nested in
a document must not carry at all: 3.1 reads it as a dialect switch. So there is no third spelling of
a document, and the plain draft is emitted as the 3.1 it already is.

**OpenAPI 3.0's Schema Object is closed.** Its meta-schema sets `additionalProperties: false` and
allows nothing beside the keywords it lists except `^x-`. That is stricter than plain JSON Schema,
where an unknown keyword is merely ignored: in a 3.0 document a keyword from a later draft makes the
whole document fail validation. Six things are translated for it:

|                     | `openapi-3.1`                     | `openapi-3.0`                         |
| ------------------- | --------------------------------- | ------------------------------------- |
| nullable            | `type: ['string', 'null']`        | `type: 'string', nullable: true`      |
| exclusive bound     | `exclusiveMinimum: 0`             | `minimum: 0, exclusiveMinimum: true`  |
| positional array    | `prefixItems: [...]`              | no equivalent, falls back to a length |
| a pinned value      | `const: 'gold'`                   | `enum: ['gold']`                      |
| base64 bytes        | `contentEncoding: 'base64'`       | `format: 'byte'`                      |
| a nullable enum ref | `anyOf: [{$ref}, {type: 'null'}]` | no equivalent, the enum stays inline  |

An enum on two or more columns is published once under `components.schemas` and referenced from each
use, in both versions. Not `$defs`: 3.0 rejects the keyword outright, and 3.1 accepts it and then
cannot resolve `#/$defs/mood`, because a `$ref` in a document resolves against the document root.
The last row above is why a nullable enum column keeps its inline list in a 3.0 document: `type:
'null'` is not one of that version's six types, and 3.0 defines every sibling of `$ref` to be
ignored, so `{ $ref, nullable: true }` is a schema that silently refuses null. See
[shared enums](/generators/json-schema#shared-enums).

No `examples` are emitted in either. 3.0 has no such keyword in a schema at all, and DRZL has no
example data to put there: a Drizzle schema says what a value must look like, never what one is.

## Relations

Off by default. With `includeRelations: true`, a child that names its parent by foreign key gets a
read-only sub-resource path:

```
GET /users/{id}/posts   ->  200, an array of postsSelect
                            404, when no users row has that id
```

Emitted only where the child has **exactly one** foreign key to the whole of the parent's primary
key. Two of them and the path is ambiguous about which it follows, which is the same reason the
[nested schemas](/generators/nested-relations) skip a child with more than one key back to its
parent. Nothing is emitted where the parent has no primary key, since there is no `{id}` to hang it
off.

A self reference is skipped too. `/users/{id}/posts` reads unambiguously because the child is a
different noun from the parent; `/employees/{id}/employees` does not, and nothing in the schema says
whether it means this employee's reports or their managers. The foreign key knows which direction it
points and the path cannot say it, so no path is emitted rather than one a reader has to guess at.

There is no `POST /users/{id}/posts`. A create there would have to merge the parent's key into the
body, and the insert schema already requires that column, so the two would contradict each other.

## `info`, `servers` and `tags`

DRZL knows a schema and nothing else, so:

- **`info`** defaults to `{ title: 'API', version: '0.0.0' }` with a description saying where the
  document came from. Set your own with `document: { info: { ... } }`.
- **`servers`** is **absent** unless you supply one. The specification reads an absent or empty
  `servers` as a single server at `/`, meaning the document describes whatever is serving it, and
  that is the only true statement a schema supports. A placeholder like `http://localhost:3000`
  would be a fabrication that tooling then follows.
- **`tags`** is one per table, named after the resource, with a description that says which table it
  is and why anything is missing from it.

Every operation also carries an `operationId` (`listUsers`, `getUsers`, `createUsers`,
`updateUsers`, `deleteUsers`, `listUsersPosts`), which is what a client generator turns into a
method name. Two tables that would produce the same one are refused.

## Which files

```ts
{ kind: 'json-schema', document: { format: 'both' } }
```

| `format`       | Writes                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ts` (default) | `openapi.ts`, exported from the barrel. What a server imports to serve its own document, and it is typechecked with the rest of the output |
| `json`         | `openapi.json`. What Swagger UI, a linter or a client generator reads directly                                                             |
| `both`         | Both                                                                                                                                       |

No YAML: it would need a dependency, and this package deliberately has none.

## A runnable config

```ts
import { defineConfig } from '@drzl/cli/config';

export default defineConfig({
  schema: 'src/db/schema.ts',
  outDir: 'src/api',
  generators: [
    {
      kind: 'json-schema',
      path: 'src/openapi',
      target: 'openapi-3.1',
      includeRelations: true,
      document: {
        format: 'both',
        info: { title: 'Shop API', version: '1.0.0' },
        servers: [{ url: 'https://api.example.com/v1' }],
      },
    },
  ],
});
```

```bash
drzl generate
```

For the whole path from that config to a served, validated document, with the validator and the
server, see [Publishing an OpenAPI document](/examples/recipes#publishing-an-openapi-document).

## The whole document, for two tables

`users` (`id serial primary key`, `email text not null unique`) and `posts` (`id serial primary
key`, `title text not null`, `author_id integer references users.id`), with `includeRelations: true`.
Abbreviated only where a block repeats verbatim; nothing is reworded.

```json
{
  "openapi": "3.1.1",
  "info": {
    "title": "API",
    "version": "0.0.0",
    "description": "Generated by DRZL from a Drizzle schema. Paths, request bodies and response bodies are derived from the schema alone; nothing here has been checked against a running server."
  },
  "paths": {
    "/users": {
      "get": {
        "operationId": "listUsers",
        "tags": ["users"],
        "summary": "List every users row.",
        "responses": {
          "200": {
            "description": "Every users row.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "array",
                  "items": { "$ref": "#/components/schemas/usersSelect" }
                }
              }
            }
          }
        }
      },
      "post": {
        "operationId": "createUsers",
        "tags": ["users"],
        "summary": "Create a users row.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": { "schema": { "$ref": "#/components/schemas/usersInsert" } }
          }
        },
        "responses": {
          "201": {
            "description": "The users row that was created.",
            "content": {
              "application/json": { "schema": { "$ref": "#/components/schemas/usersSelect" } }
            }
          },
          "400": {
            "description": "The request does not match the schema for this operation.",
            "content": {
              "application/json": { "schema": { "$ref": "#/components/schemas/Error" } }
            }
          },
          "409": {
            "description": "The row collides with an existing one on primary key (id); users_email_key (email).",
            "content": {
              "application/json": { "schema": { "$ref": "#/components/schemas/Error" } }
            }
          }
        }
      }
    },
    "/users/{id}": {
      "parameters": [
        {
          "name": "id",
          "in": "path",
          "required": true,
          "description": "id, from the primary key of users.",
          "schema": { "type": "integer", "minimum": -2147483648, "maximum": 2147483647 }
        }
      ],
      "get": {
        "operationId": "getUsers",
        "tags": ["users"],
        "summary": "Read one users row.",
        "responses": {
          "200": {
            "description": "The requested users row.",
            "content": {
              "application/json": { "schema": { "$ref": "#/components/schemas/usersSelect" } }
            }
          },
          "400": {
            "description": "The request does not match the schema for this operation.",
            "content": {
              "application/json": { "schema": { "$ref": "#/components/schemas/Error" } }
            }
          },
          "404": {
            "description": "No users row has that id.",
            "content": {
              "application/json": { "schema": { "$ref": "#/components/schemas/Error" } }
            }
          }
        }
      },
      "patch": {
        "operationId": "updateUsers",
        "tags": ["users"],
        "summary": "Patch one users row.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": { "schema": { "$ref": "#/components/schemas/usersUpdate" } }
          }
        },
        "responses": {
          "200": {
            "description": "The users row after the patch.",
            "content": {
              "application/json": { "schema": { "$ref": "#/components/schemas/usersSelect" } }
            }
          },
          "400": {
            "description": "The request does not match the schema for this operation.",
            "content": {
              "application/json": { "schema": { "$ref": "#/components/schemas/Error" } }
            }
          },
          "404": {
            "description": "No users row has that id.",
            "content": {
              "application/json": { "schema": { "$ref": "#/components/schemas/Error" } }
            }
          },
          "409": {
            "description": "The row collides with an existing one on users_email_key (email).",
            "content": {
              "application/json": { "schema": { "$ref": "#/components/schemas/Error" } }
            }
          }
        }
      },
      "delete": {
        "operationId": "deleteUsers",
        "tags": ["users"],
        "summary": "Delete one users row.",
        "responses": {
          "204": { "description": "The users row was deleted. No content is returned." },
          "400": {
            "description": "The request does not match the schema for this operation.",
            "content": {
              "application/json": { "schema": { "$ref": "#/components/schemas/Error" } }
            }
          },
          "404": {
            "description": "No users row has that id.",
            "content": {
              "application/json": { "schema": { "$ref": "#/components/schemas/Error" } }
            }
          }
        }
      }
    },
    "/users/{id}/posts": {
      "parameters": [
        {
          "name": "id",
          "in": "path",
          "required": true,
          "description": "id, from the primary key of users.",
          "schema": { "type": "integer", "minimum": -2147483648, "maximum": 2147483647 }
        }
      ],
      "get": {
        "operationId": "listUsersPosts",
        "tags": ["posts"],
        "summary": "List the posts rows belonging to one users row.",
        "responses": {
          "200": {
            "description": "The posts rows whose authorId names this users row.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "array",
                  "items": { "$ref": "#/components/schemas/postsSelect" }
                }
              }
            }
          },
          "400": {
            "description": "The request does not match the schema for this operation.",
            "content": {
              "application/json": { "schema": { "$ref": "#/components/schemas/Error" } }
            }
          },
          "404": {
            "description": "No users row has that id.",
            "content": {
              "application/json": { "schema": { "$ref": "#/components/schemas/Error" } }
            }
          }
        }
      }
    },
    "/posts": {
      "get": { "operationId": "listPosts", "tags": ["posts"], "…": "as /users" },
      "post": { "operationId": "createPosts", "…": "as /users" }
    },
    "/posts/{id}": {
      "parameters": [{ "name": "id", "…": "as /users/{id}" }],
      "get": {},
      "patch": {},
      "delete": {}
    }
  },
  "components": {
    "schemas": {
      "usersInsert": {
        "title": "insert users",
        "type": "object",
        "properties": {
          "id": { "type": "integer", "minimum": -2147483648, "maximum": 2147483647 },
          "email": { "type": "string" }
        },
        "required": ["email"],
        "additionalProperties": false
      },
      "usersUpdate": {
        "title": "update users",
        "type": "object",
        "properties": { "email": { "type": "string" } },
        "additionalProperties": false
      },
      "usersSelect": {
        "title": "select users",
        "type": "object",
        "properties": {
          "id": { "type": "integer", "minimum": -2147483648, "maximum": 2147483647 },
          "email": { "type": "string" }
        },
        "required": ["id", "email"],
        "additionalProperties": false
      },
      "postsInsert": { "title": "insert posts", "…": "id, title, authorId" },
      "postsUpdate": { "title": "update posts", "…": "title, authorId" },
      "postsSelect": { "title": "select posts", "…": "id, title, authorId" },
      "Error": {
        "title": "error",
        "description": "What an operation returns when it does not return the row.",
        "type": "object",
        "properties": { "message": { "type": "string" }, "code": { "type": "string" } },
        "required": ["message"],
        "additionalProperties": true
      }
    }
  },
  "tags": [
    { "name": "users", "description": "Table \"users\"." },
    { "name": "posts", "description": "Table \"posts\"." }
  ]
}
```

Note that `id` is present and optional in `usersInsert` and absent from `usersUpdate`. A defaulted
column may be omitted on insert and supplied; a primary key identifies the row rather than changing
it, so it is not in a patch at all. That is the same rule the per-table schemas use, unchanged.

## Verification

The emitted document is validated against the **official OpenAPI JSON Schemas** by
[`@seriousme/openapi-schema-validator`](https://www.npmjs.com/package/@seriousme/openapi-schema-validator)
2.9.1, for 3.1 and for 3.0, over a fixture carrying every column shape this generator has a branch
for. That validator was chosen because it has a real 3.1 schema rather than checking 3.1 documents
against the 3.0 one, and because it accepts a plain object, so what is validated is the exact value
the emitted module exports.

Nothing in the test suite asserts on the shape of the document. Two of the translations in the 3.0
table above, `const` and `contentEncoding`, were **found by that validator** and not by reading: the
generator emitted both into 3.0 documents, and because 3.0's Schema Object is closed, each one made
the whole document invalid.

Beyond the specification, the tests also check that every `$ref` resolves inside the document, that
nothing references a component schema that is not there, and that nothing carries a component schema
nothing points at.

## Size

Measured on ten tables of 2, 5, 10 and 20 columns, as pretty-printed JSON:

| Columns per table | Bytes per table |
| ----------------- | --------------- |
| 2                 | 6857            |
| 5                 | 7493            |
| 10                | 8553            |
| 20                | 10718           |

That is **215 bytes per column and about 6.4 KB fixed per table**, plus 768 bytes for the whole
document (the `info` block and the `Error` schema). The fixed part dominates because it is the paths
rather than the schemas: five operations, each with its responses and descriptions.

The `openapi.ts` form is within a few percent of the same figures. It is data rather than code, and
unlike the per-table validator modules it is normally served rather than bundled, but the numbers
are here so nobody has to guess.

`scripts/verify-packed.sh` has a per-column size budget for the four validator generators and none
for this one, so nothing enforces these.
