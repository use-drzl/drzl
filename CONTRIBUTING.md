# Contributing to DRZL

Thanks for your interest in contributing! This guide explains how to set up your environment, propose changes, and submit high‑quality pull requests.

## Project Setup

- Requirements:
  - Node.js 20+
  - pnpm 10+
- Install:
  - `pnpm install`
- Build, Test, Lint, Format:
  - `pnpm build`
  - `pnpm -r test`
  - `pnpm lint`
  - `pnpm format`

## Repo Structure (packages/)

- `analyzer` — Drizzle schema analysis
- `cli` — drzl CLI
- `generator-*` — code generators (oRPC, service, zod, valibot, arktype)
- `template-*` — oRPC templates
- `validation-core` — shared validation codegen helpers

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
- [ ] `pnpm lint` passes (no new warnings/errors)
- [ ] README/CHANGELOG updated where appropriate

## Testing Philosophy

- Prefer unit‑level tests near the code under test.
- Use temporary directories for any filesystem output and clean up after tests.
- Keep tests independent and deterministic.

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

## Code of Conduct

Be respectful and inclusive. By participating, you agree to uphold a welcoming environment for everyone. If you encounter unacceptable behavior, please open an issue or contact the maintainers.
