# ProfRead

ProfRead is a private, self-hosted web app for reading imported HTML
articles with context-aware LLM explanations, recursive follow-up discussions,
curated annotations, and durable study artifacts.

## Status

The application is implemented as an npm workspace with a Fastify/SQLite API,
React/Vite reader, shared validated contracts, and a Docker deployment. It
supports safe HTML/ZIP import, durable margin discussions, provider routing,
semantic highlights, revisioned article editing, a source-grounded Document
Writer, semantic summary review, search, and HTML/Markdown/PDF export.

The asynchronous [academic importer](docs/academic-importer.md) adds arXiv,
standalone PDF, public article URL/DOI, DOCX, and LaTeX conversion through an isolated worker, with deterministic
diagnostics and optional bounded LLM/VLM review.

See [docs/implementation-plan.md](docs/implementation-plan.md) for the full
architecture, interaction contracts, milestones, and acceptance tests.
The current feature and migration details are in the
[v0.5.0 release notes](docs/releases/v0.5.0.md).

## Product direction

- Import self-contained HTML or HTML-plus-assets ZIP bundles.
- Discuss selected terminology, passages, tables, images, and diagrams in a
  Word-like comment margin.
- Route work across quick, standard, deep, vision, and research model profiles
  with latency as the primary optimization criterion.
- Preserve user-curated highlights and compact recursive discussions into
  TL;DRs, half-page summaries, structured visual recaps, and derived notes.
- Keep imported source versions immutable while tracking deliberate article
  edits, annotations, Writer proposals, and exports in a single-owner,
  multi-device library.

## Intended foundation

- React, TypeScript, and Vite frontend
- Fastify backend on Node.js
- SQLite with WAL and FTS5 plus filesystem-backed imported assets
- Native OpenAI Responses, generic OpenAI-compatible Chat Completions, and an
  enhanced OpenRouter adapter
- Docker deployment behind HTTPS or a private VPN

## Development

Requires Node.js 24 or newer.

```sh
npm install
cp .env.example .env
npm run dev
```

The web app runs on port 4311 in development and proxies the API on port 4310.
Run `npm test`, `npm run typecheck`, and `npm run build` before deployment. See
[deployment and recovery](docs/deployment.md) for Docker, backup, and restore
instructions.

## Prompt templates

Source-controlled prompt defaults and their descriptions live in
[`apps/server/src/models/prompts.ts`](apps/server/src/models/prompts.ts). The
library's **AI settings → Prompt templates** panel can override each component
without rebuilding the application. The editor lists the allowed
`{{variables}}`, validates required and unknown placeholders, and can reset any
override to its source default. Overrides are stored in SQLite and therefore
follow the normal `afterdraft-data` backup and restore contract.
