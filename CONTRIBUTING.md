# Contributing to DRZL

Thanks for your interest in contributing! This guide explains how to set up your environment, propose changes, and submit high‑quality pull requests.

## Project Setup

- Requirements:
  - Node.js 22.13+ (required by pnpm 11)
  - pnpm 11+ (the exact version is pinned in `packageManager`; run `corepack enable` and let
    it pick that up rather than installing pnpm yourself)
- Install:
  - `pnpm install`
- Build, Test, Lint, Format:
  - `pnpm build`
  - `pnpm -r test`
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm format`
- The gate that matters:
  - `pnpm verify:packed` packs every package, installs the tarballs into an empty project,
    generates from three dialects, typechecks the output under three module resolutions, compares
    it column by column against the official `drizzle-orm` validators, and runs it against a real
    Postgres (PGlite) and a real SQLite (`node:sqlite`). Set `MYSQL_URL` to include MySQL, which
    CI provides as a service container; without it that stage skips and says so.
  - It takes about three and a half minutes locally (217s measured on a 16-core laptop with no
    `MYSQL_URL`, so the MySQL stages skipped; 304s in CI on a 4-core runner with MySQL running).
    It barely responds to cores, because it is dominated by npm installs. It is the only thing here
    that exercises what a consumer actually gets. Everything else imports from source.

## Repo Structure (packages/)

- `analyzer`: Drizzle schema analysis
- `cli`: drzl CLI
- `generator-*`: the fourteen code generators (oRPC, tRPC, Hono, Express, Fastify, NestJS, GraphQL,
  service, zod, valibot, arktype, typebox, effect, json-schema). All fourteen are dependencies of
  `cli`, so a consumer installing `@drzl/cli` gets every one
- `template-*`: oRPC templates
- `validation-core`: shared validation codegen helpers

Plus `examples/*`: runnable applications that consume the workspace copy of `@drzl/cli`, so a
regression in a generator breaks them. They are workspace members, which is what puts them in
`pnpm build` and `pnpm -r test` without a CI job of their own. Their generated output is committed
and guarded by `drzl generate --check` inside their own `build` script.

## Development Workflow

1. Create a feature branch from `master`:
   - `git checkout -b feature/short-desc` or `bugfix/issue-###`
2. Implement changes scoped to a single topic.
3. Run tests and lint locally (see commands above).
4. Update docs/readmes if behavior or APIs change.
5. Open a PR with a clear title and description.

### Commit Style (Conventional Commits)

Use Conventional Commits for readable history and changelog automation:

- `feat(scope): add new capability`
- `fix(scope): resolve bug`
- `docs(scope): update README`
- `refactor(scope): code change with no behavior change`
- `test(scope): add/adjust tests`
- `chore(scope): tooling, build, deps`

Examples:

- `feat(orpc): inject .output() for arktype`
- `fix(cli): apply analyzer defaults when omitted`

### Branch Naming

- `feature/<short-desc>`
- `bugfix/<short-desc>`
- `chore/<short-desc>`

### Pull Request Checklist

- [ ] Changes are focused and documented
- [ ] Tests added or updated
- [ ] `pnpm -r test` passes locally
- [ ] `pnpm typecheck` and `pnpm lint` pass (no new warnings/errors)
- [ ] `pnpm verify:packed` passes
- [ ] Docs updated where behaviour changed, including the emitted examples on the generator pages
- [ ] A changeset added for anything a consumer can observe

## Testing Philosophy

- Prefer unit‑level tests near the code under test.
- Use temporary directories for any filesystem output and clean up after tests.
- Keep tests independent and deterministic.
- **Execute the emitted code rather than matching its text.** Source text cannot tell a schema
  that validates from one that merely parses, and most of the real bugs found here were emitted
  modules that read correctly and behaved wrongly, including several that threw on import.
- **Check a new gate by breaking something on purpose.** A gate that has never failed has not been
  shown to work; several here went green on their first run while measuring nothing.

## Code Style

- TypeScript strict mode is enabled; keep types precise and narrow.
- Prefer small, composable functions and clear names.
- Follow existing patterns in the package you are editing.

## Releasing / Versioning

- The project uses SemVer for published packages.
- Maintainers handle releases; contributors don’t need to publish.
- If your change warrants a minor/major bump, call it out in the PR description.

## Reporting Issues / Proposals

- Use descriptive titles and steps to reproduce (when applicable).
- For feature proposals, outline the problem, the proposed solution, and alternatives considered.

## Sponsor-Wanted & Priority Issues

- Issues tagged `sponsor-wanted` include a scoped brief, and desired outcome. If you’d like to fund one, comment or DM @omardulaimidev on X (https://x.com/omardulaimidev) so we can reserve it for you.
- Issues tagged `priority` are high-impact items the maintainers plan to tackle next, and sponsorship accelerates them.
- Funded work always lands in this repo under Apache‑2.0 (no private forks or exclusivity).

## Code of Conduct

Be respectful and inclusive. By participating, you agree to uphold a welcoming environment for everyone. If you encounter unacceptable behavior, please open an issue or contact the maintainers.
