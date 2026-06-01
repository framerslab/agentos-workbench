<div align="center">

# AgentOS Workbench

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../logos/agentos-primary-no-tagline-dark-2x.png">
  <source media="(prefers-color-scheme: light)" srcset="../../logos/agentos-primary-no-tagline-light-2x.png">
  <img src="../../logos/agentos-primary-no-tagline-transparent-2x.png" alt="AgentOS Workbench" width="260">
</picture>

**Visual debugging and orchestration dashboard for [AgentOS](https://agentos.sh) agents.**

[![npm](https://img.shields.io/npm/v/@framers/agentos?logo=npm&color=cb3837)](https://www.npmjs.com/package/@framers/agentos)
[![License](https://img.shields.io/badge/License-MIT-green?logo=opensourceinitiative&logoColor=white)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4+-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[Website](https://agentos.sh) · [Docs](https://docs.agentos.sh) · [GitHub](https://github.com/framerslab/agentos) · [Discord](https://wilds.ai/discord) · [npm](https://www.npmjs.com/package/@framers/agentos)

</div>

---

AgentOS Workbench is a React + Vite dashboard for inspecting, debugging, and orchestrating [AgentOS](https://agentos.sh) agent sessions. It provides a zero-config cockpit for streaming [AgentOS chunks](https://docs.agentos.sh/architecture/system-architecture), session timelines, multi-agent coordination, evaluation benchmarks, and plan lifecycle management.

Built on [`@framers/agentos`](https://www.npmjs.com/package/@framers/agentos), the open-source TypeScript runtime for building production AI agents with [cognitive memory](https://docs.agentos.sh/features/cognitive-memory), [HEXACO personality](https://docs.agentos.sh/features/cognitive-memory-guide), [multi-agent orchestration](https://docs.agentos.sh/features/agency-api), and [runtime tool forging](https://docs.agentos.sh/features/emergent-capabilities).

## Features

| Feature | Description |
|---------|-------------|
| **Session Inspector** | Color-coded timeline rendering of streaming AgentOS chunks (text deltas, tool calls, tool results, workflow updates, agency updates, errors) |
| **Compose** | Request composer for prototyping agent turns, replaying transcripts, and testing multi-turn conversations |
| **Multi-Agent Dashboard** | Visualization of [6 coordination strategies](https://docs.agentos.sh/features/agency-api) (sequential, parallel, debate, review loop, hierarchical, graph DAG) |
| **Adaptive Execution** | Task-outcome KPI tracking, fail-open overrides, tool-exposure recovery state from the [adaptive execution runtime](https://docs.agentos.sh/features/capability-discovery) |
| **Evaluation** | Benchmark runner for testing agent quality, response accuracy, and guardrail effectiveness |
| **Planning** | Plan lifecycle management with checkpoint history, fork/restore, and runtime-backed graph-run inspection |
| **RAG Workspace** | Live retrieval + demo-backed document-library fallbacks across [7 vector backends](https://docs.agentos.sh/features/rag-memory) |
| **Runtime Inspector** | Inspect exports from `generateText`, `generateImage`, `AgentGraph`, `workflow()`, and `mission()` |

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/framerslab/agentos-workbench.git
cd agentos-workbench
pnpm install

# 2. Configure environment
cp .env.example .env.local
# Edit .env.local with your backend URL and API keys

# 3. Start the backend
pnpm --filter backend dev

# 4. Start the workbench
pnpm dev
# Opens at http://localhost:5175
```

## Configuration

### Frontend Environment

```ini
# Option A: Explicit API base URL
VITE_API_URL=http://localhost:3001

# Option B: Same-origin /api/* with dev proxy
VITE_BACKEND_PORT=3001
VITE_BACKEND_HOST=localhost
VITE_BACKEND_PROTOCOL=http
```

### Backend Environment

```ini
AGENTOS_WORKBENCH_BACKEND_PORT=3001
AGENTOS_WORKBENCH_BACKEND_HOST=0.0.0.0
AGENTOS_WORKBENCH_EVALUATION_STORE_PATH=../.data/evaluation-store.json
AGENTOS_WORKBENCH_PLANNING_STORE_PATH=../.data/planning-store.json
```

Provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) should be set in the backend environment. AgentOS supports [11 LLM providers](https://docs.agentos.sh/features/llm-output-validation) with automatic fallback chains.

## GMIs, Agents, and Agencies

AgentOS uses a three-layer cognitive architecture:

| Layer | Purpose | Configuration |
|-------|---------|---------------|
| **GMI** (Generalized Mind Instance) | Persona prompts, [memory policies](https://docs.agentos.sh/features/cognitive-memory), tool permissions, language preferences, [guardrail hooks](https://docs.agentos.sh/features/guardrails) | Reusable cognitive cores versioned and exported across apps |
| **Agent** | Product surface (labels, icons, availability) wrapping a GMI | Preserves GMI cognition and policy |
| **Agency** | Coordinates multiple GMIs via [6 workflow strategies](https://docs.agentos.sh/features/agency-api) | Visualized via `WORKFLOW_UPDATE` and `AGENCY_UPDATE` events |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/agentos/chat` | Send a turn (messages, mode, optional workflow) |
| `GET` | `/api/agentos/stream` | SSE stream for incremental updates |
| `GET` | `/api/agentos/personas` | List personas (filters: capability, tier, search) |
| `GET` | `/api/agentos/workflows/definitions` | List workflow definitions |
| `POST` | `/api/agentos/agency/workflow/start` | Start agency workflow |
| `GET` | `/api/agentos/graph-runs` | List persisted runtime graph-run records |
| `GET` | `/api/agentos/graph-runs/:runId` | Inspect a single graph-run record |
| `GET` | `/api/evaluation/runs` | List evaluation runs |
| `POST` | `/api/evaluation/run` | Start a new evaluation run |
| `GET` | `/api/planning/plans` | List persisted plans |
| `POST` | `/api/planning/plans` | Create a new plan |

See `backend/docs/index.html` for the generated backend route documentation.

## Storage and Data

- **Local-first**: all data stored in your browser via IndexedDB (no server writes)
- **Stored entities**: personas (remote + local), agencies, sessions (timeline events)
- **Export**: per-session from the timeline header, or all data from Settings > Data > "Export all"
- **Import**: Settings > Data > "Import..." (schema: `agentos-workbench-export-v1`)
- **Clear**: Settings > Data > "Clear storage"

See [`CLIENT_STORAGE_AND_EXPORTS.md`](../../docs/CLIENT_STORAGE_AND_EXPORTS.md) for details.

## Scripts

```bash
pnpm dev              # Vite dev server at http://localhost:5175
pnpm build            # Production build (emits dist/)
pnpm preview          # Preview production build
pnpm lint             # ESLint
pnpm typecheck        # TypeScript type checking
pnpm e2e              # All Playwright test suites
pnpm e2e:chromium     # Chromium only
pnpm e2e:firefox      # Firefox only
pnpm e2e:webkit       # WebKit (serialized for stability)
pnpm bundle:report    # Bundle size analysis
pnpm bundle:check     # Enforce bundle size budgets
pnpm build:check      # Build + bundle report + budget enforcement
```

## AgentOS Ecosystem

| Package | Description | Links |
|---------|-------------|-------|
| [`@framers/agentos`](https://www.npmjs.com/package/@framers/agentos) | Core TypeScript AI agent runtime | [GitHub](https://github.com/framerslab/agentos) · [Docs](https://docs.agentos.sh) |
| [`@framers/sql-storage-adapter`](https://www.npmjs.com/package/@framers/sql-storage-adapter) | SQL persistence for agent memory and sessions | [npm](https://www.npmjs.com/package/@framers/sql-storage-adapter) |
| [AgentOS Workbench](https://github.com/framerslab/agentos-workbench) | Visual debugging dashboard (this repo) | [GitHub](https://github.com/framerslab/agentos-workbench) |
| [AgentOS Docs](https://docs.agentos.sh) | Guides, tutorials, and TypeDoc API reference | [docs.agentos.sh](https://docs.agentos.sh) |
| [Wilds.ai](https://wilds.ai) | AI game worlds powered by AgentOS | [wilds.ai](https://wilds.ai) |

## License

- **AgentOS core** ([`@framers/agentos`](https://github.com/framerslab/agentos)) — [Apache 2.0](https://github.com/framerslab/agentos/blob/master/LICENSE)
- **Workbench** — MIT

---

<p align="center">
  <a href="https://agentos.sh">
    <img src="../../logos/agentos-primary-no-tagline-transparent-2x.png" alt="AgentOS" height="36" />
  </a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="https://frame.dev">
    <img src="../../logos/frame-logo-green-transparent-4x.png" alt="Frame.dev" height="36" />
  </a>
  <br /><br />
  Built by <a href="https://manic.agency">Manic Agency LLC</a> / <a href="https://frame.dev">Frame.dev</a>
</p>
