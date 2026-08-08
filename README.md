# Co-reader

Co-reader is a planned private, self-hosted web app for reading imported HTML
articles with context-aware LLM explanations, recursive follow-up discussions,
curated annotations, and durable study artifacts.

## Status

This repository is an implementation handoff. It currently contains the
decision-complete product and engineering specification; application code has
not been scaffolded yet.

See [docs/implementation-plan.md](docs/implementation-plan.md) for the full
architecture, interaction contracts, milestones, and acceptance tests.

## Product direction

- Import self-contained HTML or HTML-plus-assets ZIP bundles.
- Discuss selected terminology, passages, tables, images, and diagrams in a
  Word-like comment margin.
- Route work across quick, standard, deep, vision, and research model profiles
  with latency as the primary optimization criterion.
- Preserve user-curated highlights and compact recursive discussions into
  TL;DRs, half-page summaries, structured visual recaps, and derived notes.
- Keep articles immutable while persisting annotations and exports in a
  single-owner, multi-device library.

## Intended foundation

- React, TypeScript, and Vite frontend
- Fastify backend on Node.js
- SQLite with WAL and FTS5 plus filesystem-backed imported assets
- Native OpenAI Responses, generic OpenAI-compatible Chat Completions, and an
  enhanced OpenRouter adapter
- Docker deployment behind HTTPS or a private VPN

The implementation plan is organized as three vertical milestones so the first
milestone produces a usable reader before provider routing and the recursive
knowledge layer are added.
