# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start Next.js dev server on http://localhost:3000
npm run build        # Production build
npm run lint         # ESLint (eslint-config-next/core-web-vitals)
npm run typecheck    # tsc --noEmit
```

No test framework is configured.

## Architecture

ToolCall-15 is a Next.js App Router application (TypeScript, React) that benchmarks LLM tool-calling ability across 15 deterministic scenarios. It uses Server-Sent Events to stream live results to a dashboard.

### Data flow

1. **`app/page.tsx`** — Server component. Reads model config from env, passes public model info and scenario metadata to the client Dashboard.
2. **`components/dashboard.tsx`** — Client component. Initiates benchmark runs via `GET /api/run` (SSE), renders the live score matrix, handles per-scenario reruns (Shift+Click).
3. **`app/api/run/route.ts`** — SSE endpoint. Streams `RunEvent` objects. Accepts `?models=` and `?scenarios=` query params to filter runs.
4. **`lib/orchestrator.ts`** — Runs each scenario against each model. Multi-turn loop (up to 8 turns) with mock tool execution, provider-error retry (3 attempts with backoff), and 30s per-request timeout.
5. **`lib/llm-client.ts`** — Thin OpenAI-compatible `/chat/completions` adapter. Normalizes content formats and tool call shapes across providers. Uses `temperature: 0`.
6. **`lib/models.ts`** — Parses `LLM_MODELS` / `LLM_MODELS_2` env vars into `ModelConfig` objects. Normalizes host URLs to `/v1` base for Ollama and llama.cpp.
7. **`lib/benchmark.ts`** — The benchmark spec: system prompt, 12 universal tool definitions, 15 scenario definitions (user message, mock `handleToolCall`, deterministic `evaluate`), and `scoreModelResults` aggregation.

### Scoring

5 categories (A-E), 3 scenarios each. Each scenario scores 0/1/2 (fail/partial/pass). Category score = sum/6 as percentage. Final score = average of 5 category percentages.

### Providers

Four supported: `openrouter`, `ollama`, `llamacpp`, `afm`. Configured as comma-separated `provider:model` entries in `LLM_MODELS` (primary table) and `LLM_MODELS_2` (secondary table). All models must be unique across both env vars. `afm` is the local AFM server (maclocal-api) — requires `AFM_HOST` env var (e.g. `http://localhost:9999`).

### Key constants

- Benchmark reference date: `2026-03-20 (Friday)` — hardcoded in `llm-client.ts` and `benchmark.ts`
- Max assistant turns per scenario: 8
- Model request timeout: 30s
- Provider error retries: 3 with 750ms * attempt backoff

## Conventions

- Path aliases use `@/` mapped to project root (tsconfig `paths`).
- `next.config.mjs` enables `typedRoutes`.
- No CSS framework — plain CSS in `app/globals.css`.
- `maclocal-api/` is a separate nested repo (its own `.git`), not part of this project's source.
