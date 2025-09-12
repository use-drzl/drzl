# Repository Guidelines

## Project Structure & Modules

- Root: pnpm workspace with TypeScript packages under `packages/*`.
- Packages: `analyzer`, `cli`, `generator-*`, `template-*`, `validation-core` (each has `src/`, `test/`, `dist/`).
- Docs: VitePress site in `docs/` (not published with packages).
- Assets & scripts: `assets/`, `scripts/` (branding utilities).
- Examples: `real-world-example/` for end-to-end usage.

## Build, Test, and Dev

- Install deps: `pnpm install`
- Build all: `pnpm build` or `pnpm -r run build`
- Dev CLI: `pnpm dev` (runs `@drzl/cli` in watch/dev mode)
- Tests: `pnpm test` (runs Vitest across workspaces)
- Lint: `pnpm lint` (ESLint on `.ts`)
- Format: `pnpm format` (Prettier write)
- Docs: `pnpm docs:dev | docs:build | docs:preview`

## Coding Style & Naming

- Language: TypeScript (ESM, Node >= 18.17; dev on Node 20+ preferred).
- Formatting: Prettier; run `pnpm format` before committing.
- Linting: ESLint (`eslint.config.js`, `@typescript-eslint/*`). Fix warnings where feasible.
- Indentation: 2 spaces; limit line length to ~100–120 chars.
- Names: kebab-case for packages (`generator-zod`), PascalCase for types, camelCase for functions/vars, UPPER_SNAKE for constants.

## Testing Guidelines

- Framework: Vitest.
- Structure: tests live in `packages/*/test` with `*.test.ts` files.
- Running: `pnpm -r test`; to focus a package: `pnpm --filter @drzl/<pkg> test`.
- Keep tests deterministic; use temp dirs for filesystem codegen tests.

## Commits & Pull Requests

- Commits: Conventional Commits (e.g., `feat(cli): add init command`, `fix(analyzer): handle enums`).
- Branches: `feature/<short-desc>`, `bugfix/<short-desc>`, `chore/<short-desc>`.
- PRs: clear description, linked issue, rationale, screenshots/CLI output when relevant. Include docs/README updates for user-facing changes.
- Checks: ensure `pnpm -r test`, `pnpm lint`, and `pnpm build` pass.
- Releases: Changesets drive versioning; maintainers run `pnpm release`.

## Security & Configuration

- No secrets in repo or tests. Use local env only.
- Respect ESM: avoid `require`; use `import` and `type` imports where applicable.
- Prefer small, composable functions; keep public APIs stable and documented in package READMEs.
