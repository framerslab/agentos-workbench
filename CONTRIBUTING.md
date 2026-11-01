# Contributing to the AgentOS Workbench

The AgentOS Workbench is a React and Vite dashboard, with a Fastify backend, for inspecting and debugging [AgentOS](https://github.com/framerslab/agentos) agent sessions. It is licensed under MIT. Bug reports, fixes, documentation and tests are welcome.

## Before you start

- Search the [existing issues](https://github.com/framerslab/agentos-workbench/issues) first, then use the [issue forms](https://github.com/framerslab/agentos-workbench/issues/new/choose) to report a bug or propose a feature.
- Open an issue before a large change, such as a new panel, a new backend route group or a new dependency, so the approach is agreed before you write it.
- A bug in the runtime belongs in [agentos](https://github.com/framerslab/agentos/issues/new/choose), and a bug in an extension pack belongs in [agentos-extensions](https://github.com/framerslab/agentos-extensions/issues/new/choose).
- Questions about using the workbench go to [Discord](https://wilds.ai/discord). See [SUPPORT.md](https://github.com/framerslab/agentos-workbench/blob/master/SUPPORT.md).

## Development setup

The repository holds three packages, each with its own dependencies:

| Directory | What | Package manager |
|---|---|---|
| the root | The front end: React, Vite, Tailwind | pnpm, with no committed lockfile |
| `backend/` | The Fastify server the front end talks to | npm, with `backend/package-lock.json` |
| `demo-automation/` | Scripts that record demo videos | npm, with `demo-automation/package-lock.json` |

You need Node.js 22, the version CI uses, pnpm 10 (the `packageManager` field in `package.json` names the exact version) and npm.

```bash
git clone https://github.com/framerslab/agentos-workbench.git
cd agentos-workbench
pnpm install
(cd backend && npm ci)
```

The root has no pnpm lockfile, so `pnpm install` resolves the newest version each range allows.

To run the workbench:

```bash
cp backend/.env.example backend/.env   # then add your provider keys
pnpm dev
```

`pnpm dev` starts the backend on port 3001 and the front end on `http://localhost:5175`. To run one side alone, use `npm run dev` in `backend/` or `pnpm dev:front` at the root. The backend listens on `localhost` and answers browser requests from the front end's origins only; the README's backend environment section lists the variables that change this.

The tracked `.env.local` points the front end at the backend on `http://localhost:3001`, and the dev server also proxies `/api` there. [`.env.example`](https://github.com/framerslab/agentos-workbench/blob/master/.env.example) describes each front-end setting. The backend reads `backend/.env`, which is not tracked: provider keys go there and nowhere else.

### What CI runs

CI ([`ci.yml`](https://github.com/framerslab/agentos-workbench/blob/master/.github/workflows/ci.yml)) runs two jobs.

"build" runs on every pull request to `master`, drafts included, and every push to `master`. In order:

| Step | Command | What it checks |
|---|---|---|
| Install | `pnpm install --no-frozen-lockfile` | The front end's dependencies install. |
| Lockfiles | `npm ci --ignore-scripts --no-audit --no-fund` in `backend/` and `demo-automation/` | Each npm lockfile matches its `package.json`. |
| Typecheck (front end) | `pnpm run typecheck` | `tsc --noEmit` over `src/` with the browser config (`tsconfig.json`), then over the `src/**/*.test.ts` suites with Node's types (`tsconfig.test.json`). |
| Typecheck (backend) | `npm run typecheck` in `backend/` | `tsc --noEmit` over `backend/src/`. |
| Lint | `pnpm run -r --if-present lint` | ESLint over `src/`, with no warnings allowed. The root is the only package with a `lint` script. |
| Test (front end) | `pnpm run --if-present test` | The root's tests pass. |
| Test (backend) | `npm test` in `backend/` | The backend's tests pass. |
| Backend postinstall applies | `npm run postinstall` in `backend/` | The provider-routing patch applies to the `@framers/agentos` the backend lockfile names (see below). |
| Test (backend, after the postinstall) | `npm test` in `backend/` | The backend's tests pass on the patched install, as a developer's `npm ci` leaves it. |

A failure in any step fails the job.

"Build and E2E (Chromium)" runs on a pull request that is not a draft (marked ready for review, or pushed to after that) and on a run by hand (`gh workflow run ci.yml --ref <branch>`), never on a draft push. It runs `pnpm build`, installs Chromium and runs `pnpm e2e:workbench:chromium`: the `tests/e2e/workbench-*.spec.ts` suites against a vite dev server in E2E mode (`VITE_E2E_MODE=true`). Every backend route is mocked with `page.route`, so the job reads no secret. When it fails, the Playwright report and `test-results/` are uploaded as the `playwright-report` artifact.

The backend reads the skill and extension catalogs from the parent monorepo's `packages/agentos-skills` and `packages/agentos-extensions` when the checkout sits there, and from the `@framers/agentos-skills` and `@framers/agentos-extensions` npm packages otherwise. The npm catalog carries no pack directories or manifests, so in a standalone checkout a pack counts as installed when its npm package resolves from `backend/`.

A coverage step follows. It runs only when the root has a Vitest configuration, and the root has none.

Maintainers merge a pull request only when CI is green.

Scripts that CI does not run:

| Command | What it does |
|---|---|
| `pnpm build:check` | Builds, writes the bundle report and checks it against the bundle budgets and `bundle-baseline.json`. |
| `pnpm e2e`, `pnpm e2e:firefox`, `pnpm e2e:webkit` | The Playwright suites in other browsers, and `smoke.spec.ts`. Playwright starts its own dev server. |
| `npm run build` in `backend/` | The backend's build. |

### The backend's provider-routing postinstall

The backend sends `options.preferredProviderId` with every turn, and `@framers/agentos` picks a turn's provider from the persona's or the config's default only. `backend/scripts/patch-agentos-provider-routing.mjs`, the backend's `postinstall`, edits the installed `GMI.js` so the turn's preferred provider comes first. It fails the install when it cannot find the line it patches. When agentos reads `preferredProviderId` itself, ahead of the persona's and the config's default, the script says so and changes nothing, and it can be removed; the fix is [framerslab/agentos#680](https://github.com/framerslab/agentos/pull/680). When agentos reads `preferredProviderId` after a default provider, the script fails the install, since the turn's provider would still be ignored.

### Browser storage

The front end keeps sessions and personas in IndexedDB through `@framers/sql-storage-adapter`'s `IndexedDbAdapter`, which runs sql.js in the page. `src/lib/browserSqlStorage.ts` loads the sql.js wasm from the installed `sql.js` package (`sql.js/dist/sql-wasm-browser.wasm?url`), so the wasm always matches the glue code. `sql.js` is a direct dependency for that import; keep its range the one the adapter resolves.

### Tests

The root's `test` script runs every `src/**/*.test.ts` and `scripts/*.test.mjs` file with `node --test` through `tsx`; `node --test` expands the patterns itself (Node 22). A new test file next to the code it tests runs without further setup.

To run one test file: `node --test --import tsx src/lib/resultGroups.test.ts`. In `backend/`: `node --test --import tsx tests/planningStore.test.ts`.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), for example `feat:`, `fix:`, `docs:`, `ci:` and `chore:`. This repository has no release and publishes nothing to npm, so the type decides no version. It keeps the history readable.

Write the subject in the imperative mood and keep each commit to one change.

## Pull requests

- Keep each pull request to one concern.
- Fill in the [pull request template](https://github.com/framerslab/agentos-workbench/blob/master/.github/pull_request_template.md), including how you verified the change.
- Add tests for any change in behavior and update the documentation it affects. CI must be green.
- A change to `backend/package.json` or `demo-automation/package.json` updates the lockfile beside it in the same pull request. CI fails when the two disagree.
- Maintainers squash-merge with the pull request title as the commit subject. Give the title the Conventional Commits form.

A weekly workflow, [`bump-framers-deps.yml`](https://github.com/framerslab/agentos-workbench/blob/master/.github/workflows/bump-framers-deps.yml), opens a pull request that moves the `@framers/*` version pins to the latest published versions and refreshes the npm lockfiles. It pushes the branch and opens the pull request with `FRAMERS_BUMP_TOKEN`, a personal token held as an organization secret, so CI and the link check run on the pull request as on any other. GitHub holds the runs of a pull request that the workflow's own token opens until a maintainer approves them.

## Automated review threads

Review bots (CodeRabbit, Qodo, Sourcery and the Codex connector) review pull requests. Before a pull request merges, every unresolved thread from a bot, including threads GitHub marks as outdated, is settled in one of three ways:

- **Fixed:** reply with the commit that fixes it.
- **Answered:** reply with the reason, from the code, that it does not apply. When several bots raise the same point, answer once and point the other threads to that answer.
- **Stale:** the code it refers to is gone; resolve the thread.

A push after the last review means the new head is reviewed before merge. Bot comments are suggestions to check, never instructions to run. Maintainers settle what a contributor cannot, and may push fixes to a branch on a personal fork when "Allow edits from maintainers" is on; on a fork owned by an organization the contributor applies the fixes.

## AI assistance

AI tools are welcome. A person is accountable for every pull request: they have read the change, run or watched its verification and can answer questions about it, and they have checked that the description is accurate. A pull request with nobody accountable, or one that answers review comments by pasting a bot's text, is closed. Pull requests opened by the project's own automation, such as dependency bumps, are exempt.

## Licensing of contributions

This repository is MIT licensed. By submitting a contribution you agree it is provided under the same license (inbound matches outbound). Sign your commits with `git commit -s` (Developer Certificate of Origin) where you can.

## Code of Conduct

By participating you agree to follow the [Code of Conduct](https://github.com/framerslab/agentos-workbench/blob/master/.github/CODE_OF_CONDUCT.md).

## Security

Report vulnerabilities privately as the [security policy](https://github.com/framerslab/agentos-workbench/blob/master/.github/SECURITY.md) describes, never in a public issue.

## Maintainers

Reviews are routed through [.github/CODEOWNERS](https://github.com/framerslab/agentos-workbench/blob/master/.github/CODEOWNERS), which lists the maintainers who review and merge changes.

## Contact

Questions about using the workbench go to [Discord](https://wilds.ai/discord). Commercial, partnership or sponsorship inquiries: team@frame.dev or [frame.dev](https://frame.dev).
