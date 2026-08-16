# Academic importer

AfterDraft converts academic sources into the same sanitized, browsing-first
HTML and local-asset format used by ordinary imports. The source remains
immutable; conversion diagnostics, model findings, review decisions, and the
published document version are durable records.

## Supported sources

- An arXiv ID or official `arxiv.org` abstract, HTML, or PDF URL. The server
  fetches only bounded HTTPS resources on arXiv-owned hosts and copies required
  styles, figures, and fonts into local assets.
- A Word `.docx` manuscript. The converter inventories OOXML constructs before
  using Pandoc for semantic HTML/MathML and LibreOffice/PDF only as optional
  visual-reference evidence.
- A `.tex` file or LaTeX project ZIP. The project archive is extracted with
  traversal, link, file-count, byte, and expansion limits. LaTeXML is the
  preferred semantic converter, with Pandoc as a diagnostic fallback.
- Existing HTML and HTML-asset ZIPs continue through the common sanitizer.

## Execution boundary

The public Fastify process owns authentication, arXiv network fetching, job
state, model calls, sanitization, and persistence. Costly document tools run in
the credential-free `academic-worker` sidecar over a private Compose network.
The worker has no host port, no Docker socket, no application data volume, no
outbound network, a read-only root filesystem, dropped capabilities, bounded
temporary storage, and subprocess time/output limits.

An import is an asynchronous job:

1. validate and inventory the source;
2. convert into a normalized bundle (`document.html`, local assets, manifest,
   warnings, and provenance);
3. pass the bundle through the common sanitizer and block indexer;
4. render deterministic desktop/narrow evidence and DOM measurements;
5. optionally run bounded model-assisted review;
6. present warnings and findings for review;
7. publish only after the reader finalizes the job.

An optional source-rendering or model-provider outage must not discard a valid
deterministic draft. Interrupted jobs are recoverable as retryable records, and
model review is reported as partial or not run rather than silently treated as
clean.

## Academic semantics

The common final format retains native MathML (including inline equations),
safe internal fragments and HTTPS/mail references, figures, captions, tables,
footnotes, locally copied images and fonts, and safe YouTube embeds. Hidden MathML annotations and Word/Zotero
field instructions are excluded from canonical article text. Converter-provided
semantic source keys seed stable block identity; presentation changes therefore
do not need to invalidate discussions and highlights.

Page dimensions, columns, running headers, and print pagination are not part of
the browsing view. Wide tables use scroll containers, visuals remain responsive
and enlargable, and source ordering/associations that require judgment are
surfaced for review rather than guessed silently.

## Model-assisted review

Deterministic code remains authoritative for extraction, byte/signature checks,
counts, sanitization, and DOM measurements. Models are complementary auditors:

- GPT-5.6 Luna performs inexpensive manifest/outline triage.
- GPT-5.6 Terra checks visible semantic correspondence.
- GPT-5.6 Sol reviews labeled visual evidence.

Each call has a forced strict findings tool, no web or executable tools, no
cross-provider fallback, explicit evidence IDs, and `store: false`. Manuscript
content is untrusted evidence, never instructions. Unknown IDs, coordinates,
selectors, HTML, CSS, or manuscript rewrites are rejected. Default policy is 30
calls, hard maximum 40, and concurrency two. Coverage is marked partial whenever
an outline, evidence set, call budget, or model report leaves supplied material
unreviewed.

Automatic repair is off by default. When explicitly enabled, only
high-confidence responsive sizing, overflow wrapping, and fixed-dimension
removal corroborated by deterministic Chromium metrics may be accepted
automatically. The same guard applies to a reader accepting a repair. Accepted
operations use the normal document edit engine while the initial version is
published, and publication fails if canonical text changes. Caption
associations, moves, semantic roles, alt text, prose, equations, citations,
numbers, and table cells remain reader-reviewed and cannot enter this repair
path.

The import dialog discloses that visible derivatives and labeled screenshots
may be sent to OpenAI. Original archives, hidden OOXML fields, and Zotero JSON
are not sent. API response storage is disabled; the operator's OpenAI project
retention policy still applies.

## Fixture acceptance

The two private manuscript fixtures are local deployment tests and must never
be committed. A successful Word conversion preserves all visible front matter,
headings, inline/display equations, seven figures, two tables, forty rendered
citations, the 36-entry bibliography, and current-view tracked insertions while
excluding IEEE template chrome and hidden Zotero JSON. Warnings must identify
tracked changes, missing alt text, and ambiguous/inconsistent captions. Visual
review checks both desktop and narrow reading views without treating print page
breaks or column geometry as web-layout requirements.

## Operations and backup

The sidecar is part of the AfterDraft Compose lifecycle but stores no durable
state. SQLite, normalized sources/assets, review evidence retained with each
import job, and final edits remain in `afterdraft-data`; the existing backup/restore unit is
therefore unchanged. Back up before migrations, deploy both containers from one
committed revision, verify the app and worker health endpoints, import both
private fixtures, then confirm the service through the existing Tailscale HTTPS
route.
