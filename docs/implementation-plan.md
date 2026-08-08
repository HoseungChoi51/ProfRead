# Interactive LLM Co-reader implementation plan

## Summary

Build a greenfield, private self-hosted web app for importing HTML articles,
discussing selected passages or diagrams, and retaining a curated knowledge
layer over months of reading.

Use a TypeScript npm workspace with a React/Vite frontend, Fastify backend,
SQLite in WAL mode with FTS5, and filesystem-backed document assets. Package it
for Docker deployment behind an HTTPS reverse proxy or private VPN. One
password-protected owner account shares the same library across devices.

Deliver in three usable milestones:

1. Secure reader, HTML import, annotations, OpenAI discussion, and persistence.
2. Multi-provider routing, compact contexts, vision, structured diagrams, and
   explicit web research.
3. Recursive compaction, summaries, visual recaps, search, version migration,
   and exports.

## Reader, import, and annotations

- Import either self-contained `.html` files or ZIP bundles containing HTML,
  relative CSS, images, SVG, and fonts. If a ZIP has multiple HTML entry
  points, present an entry-file picker.
- Keep uploaded sources immutable. Store each content hash as a document
  version and deduplicate identical imports.
- Sanitize imported content by removing scripts, event handlers, forms,
  iframes, embedded objects, remote CSS imports, and unapproved network URLs.
  Render it in a CSP-restricted sandboxed iframe with an injected,
  nonce-protected selection bridge.
- Rewrite relative asset references to server-managed immutable asset URLs.
  Default limits are 10 MB standalone HTML, 100 MB ZIP, 250 MB decompressed
  content, and 1,000 entries. Reject traversal paths, symlink entries,
  unsupported MIME types, and ZIP bombs.
- Assign stable block IDs during ingestion and store anchors using block ID,
  exact quote, prefix/suffix context, and global text offsets. On a new document
  version, reattach exact or fuzzy matches and show unmatched annotations in a
  repair list.
- Present a Word-like comment margin aligned with highlighted passages. Cards
  stack around collisions with leader lines; clicking either card or highlight
  synchronizes scrolling. On narrow screens, the margin becomes a synchronized
  drawer.
- Text selection opens a floating toolbar with Define, Explain, Explain for a
  14-year-old, Ask, Highlight, Compact, and Summarize. Images, SVGs, tables, and
  diagram containers are selectable as blocks.
- A thread is rooted at an article anchor or answer anchor. Selecting text
  inside an LLM response creates a nested child thread directly beneath that
  response, preserving locality instead of moving into a separate chat UI.
- Distinguish ordinary discussion anchors from user-curated highlights.
  "Checked" means manually retained as relevant; it does not imply factual
  verification.

## Model providers, routing, and context

- Implement three adapters:
  - Native OpenAI Responses for streaming, vision, structured output, state,
    and built-in tools.
  - Generic OpenAI-compatible Chat Completions for direct DeepSeek, Qwen, Kimi,
    and similar endpoints.
  - Enhanced OpenRouter support for its model catalog, routing controls,
    normalized citations, and server tools. Do not assume its Responses endpoint
    is stateful.
- Store provider and model configuration in SQLite but reference API keys by
  environment-variable name. Never return keys to the browser or persist them
  in the database.
- Model definitions declare protocol, context window, maximum output, text,
  vision, structured-output, function-tool, provider-web-search,
  reasoning-control, and streaming capabilities.
- Configure named profiles for quick, standard, deep, vision, research, and
  digest work. Every request shows the routed model and context tier and permits
  a manual override.
- Route without an extra call when intent is clear:
  - Single-term Define routes to quick.
  - Predefined Explain or ELI14 routes to standard.
  - Two or more question sentences, or more than 240 characters of freeform
    input, routes to deep.
  - A selected image or diagram routes to vision.
  - Visualize routes to a structured-diagram-capable model.
  - An explicit Research or Web toggle routes to research.
- Send only ambiguous remaining freeform requests to the quick model for a
  constrained `quick | standard | deep` classification. Apply a short timeout
  and fall back deterministically to standard or deep.
- Filter candidates by capabilities and context fit, then prefer configured
  priority and recent rolling time-to-first-token. Record routing reason,
  attempts, context tier, latency, usage, and fallback model for every run.
- On first article open, start one non-blocking deep-profile request that
  produces two validated contexts:
  - Brief: `min(3,000 tokens, 25% of canonical article tokens)`.
  - Study: `min(12,000 tokens, 60% of canonical article tokens)`.
  - For articles below 1,200 tokens, use the canonical article for every tier.
- Compose request context as follows:
  - Quick receives the brief context, exact anchor, neighboring block, local
    thread, and relevant curated notes.
  - Standard receives the study context, selected scope, active ancestor
    branch, and curated notes.
  - Deep, vision, and research receive the complete canonical article and
    active branch whenever the selected model can hold them.
  - If a full bundle does not fit, try a larger eligible model first. If none
    fits, use the study article context plus a versioned branch digest and
    display that choice. Never silently truncate.
- Capture selected diagrams as sanitized SVG plus a raster preview when
  possible; capture other visual blocks as PNG. Include their caption and
  surrounding article context with vision requests.
- Scope tools by action:
  - Normal explanations and freeform discussion receive no tools.
  - Visualize receives only the internal typed diagram tool.
  - Web search is enabled only by an explicit research action or toggle and
    only on a model/provider declaring that capability.
  - Do not expose arbitrary shell, code execution, browser automation, or
    provider tools.

## Persistent knowledge and summaries

- Store documents, versions, assets, anchors, highlights, threads, messages,
  model runs, tool events, citations, artifacts, background jobs, model
  settings, reading progress, and export history.
- Make TL;DR, half-page summary, visual recap, and Compact available on a
  document, section, individual answer, or thread subtree.
- Use these output contracts:
  - TL;DR: at most five bullets and 150 words.
  - Half-page: 300 to 450 words.
  - Compact note: prioritizes user-curated highlights and preserves backlinks
    to every source passage or message.
  - Visual recap: typed JSON containing title, thesis, up to six sections, key
    relationships, takeaways, open questions, and source references.
- Render visual recaps and concept diagrams as accessible HTML/SVG using
  allowlisted flow, hierarchy, timeline, cause/effect, and comparison layouts.
  Validate model output and permit one schema-repair attempt before falling
  back to prose.
- Compaction creates a new immutable, versioned derived artifact. It never
  deletes or rewrites the original answer. Promoted artifacts appear in the
  article margin and become eligible context for later questions.
- Add library search over article text, answers, curated highlights, and
  derived artifacts using SQLite FTS5. Include filters for document, tag,
  artifact type, model, and date. Do not add an embedding or vector database in
  v1.
- Persist reading position and last-opened thread per document.

## Public interfaces and exports

- Define a normalized provider interface with `listModels`, `estimateContext`,
  and streaming `run` operations. Normalize events into text deltas, citations,
  tool calls and results, usage, completion, cancellation, and typed errors.
- Define shared validated types for `ModelDefinition`, `ModelProfile`,
  `AnchorSelector`, `ContextBundle`, `DiscussionThread`, `ModelRun`, `Citation`,
  `DiagramSpec`, and versioned `KnowledgeArtifact`.
- Expose authenticated REST endpoints for imports and documents, anchors and
  threads, runs, artifacts, settings, search, and exports. Stream model output
  and background-job status over SSE; support cancellation and idempotent
  retry.
- Export:
  - Self-contained annotated HTML with sanitized source, curated highlights,
    notes, recaps, and optional full transcript.
  - Printable PDF, including an A4 one-page visual recap.
  - Markdown study notebook with source metadata, highlights, footnotes, and
    appendix.
- Default export includes only curated highlights and promoted artifacts. Full
  discussion history is an explicit option.
- In HTML export, notes up to 400 characters become accessible popovers;
  401-1,200 characters become numbered section footnotes; longer artifacts and
  visual recaps go into an appendix. PDF and Markdown convert popovers into
  numbered footnotes.

## Milestones

### 1. Reader foundation

Implement owner authentication, SQLite and storage migrations, HTML/ZIP
ingestion, the safe document viewer, durable anchoring, Word-like margin
threads, library and progress views, native OpenAI streaming, and basic model
settings.

### 2. Routing and tools

Add generic Chat and OpenRouter adapters, the capability registry,
rule/classifier router, latency telemetry, first-open brief and study contexts,
context-fit logic, vision capture, structured diagrams, explicit web research,
and normalized citations.

### 3. Knowledge layer

Add recursive highlights and compaction, all summary scopes, the visual recap
renderer, FTS search, document-version anchor migration, HTML/PDF/Markdown
exports, Docker packaging, backup and restore documentation, and final
accessibility and security hardening.

## Test plan

- Unit-test HTML/CSS/SVG sanitization, ZIP traversal and bomb rejection,
  canonical text extraction, stable anchors, reattachment scoring, router
  thresholds, context budgeting, provider event normalization, diagram
  validation, and export placement rules.
- Add mocked contract tests for OpenAI Responses, generic Chat Completions, and
  OpenRouter streaming, tool, and citation variants. Keep live-provider tests
  opt-in and environment-key gated.
- End-to-end test importing a self-contained technical article and a ZIP with
  assets. Verify styling and SVG preservation, selection actions, aligned
  comments, nested answer threads, refresh persistence, cancellation, model
  override, and multi-device session behavior.
- Verify routing for terminology, predefined prompts, long freeform questions,
  vision, visualization, and explicit research. Confirm no tool is enabled
  outside its action.
- Verify brief and study generation is non-blocking, cached per document
  version, invalidated only on source-version change, and disclosed whenever
  used.
- Verify curated highlights survive compaction and appear with correct
  backlinks in HTML, PDF, and Markdown exports.
- Security-test login throttling, CSRF and session cookies, malicious HTML,
  remote resource blocking, asset MIME confusion, ZIP attacks, Markdown
  sanitization, and model-generated diagram payloads.
- Accessibility-test keyboard selection actions, focus movement between anchor
  and margin card, screen-reader labels, contrast, and narrow-screen drawer
  behavior.

## Assumptions and defaults

- The app is single-owner and privately self-hosted. Collaboration, roles, and
  isolated user libraries are out of scope.
- Deployment uses one persistent data volume containing SQLite and document
  assets, backed up together. HTTPS is terminated by an existing reverse proxy
  or private VPN.
- Provider keys are server environment or Docker secrets. Settings store only
  secret references.
- Imported sources remain immutable; re-imports create versions. URL, PDF,
  EPUB, and live-page ingestion are out of scope.
- External resources referenced by imported HTML are blocked unless bundled in
  the ZIP.
- LLM answers use the language of the user's request by default.
- Sending full context may disclose the full imported article to the selected
  external provider. The UI shows provider, model, context tier, and enabled
  tools before submission.
- "Checked" means user-curated relevance only. Automated fact verification is
  not included.

## Provider references

- [OpenAI Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)
- [Kimi API overview](https://platform.kimi.ai/docs/api/overview)
- [Qwen OpenAI-compatible Responses](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-responses)
- [OpenRouter Responses API](https://openrouter.ai/docs/api/reference/responses/overview)
