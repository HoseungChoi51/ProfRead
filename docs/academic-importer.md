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
- A standalone paper PDF. Born-digital text is reconstructed into browsing
  blocks while every accepted page remains available as a folded, enlargeable
  source image. Scanned pages use that visual fallback without claiming OCR or
  recovered equation semantics.
- A public HTTPS article page or DOI. AfterDraft tries the requested article,
  then may use an exact-DOI PMC/Europe PMC open full-text source when the
  publisher is blocked. Requested and resolved sources, adapter, license, and
  content hashes remain visible provenance.
- Existing HTML and HTML-asset ZIPs continue through the common sanitizer.

## Execution boundary

The public Fastify process owns authentication, bounded public-source fetching, job
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

PDF imports process every page within the configured 100-page/100-MiB input
limits; they never silently truncate to the visual-review sampling limit.
Positioned native text remains selectable. Figures, tables, and equations whose
semantics cannot be recovered safely remain visual crops, backed by the folded
source page. Models may flag or propose presentation repairs, but cannot
transcribe or invent scholarly content.

Public web imports execute no publisher JavaScript and receive no browser
cookies, login state, proxy credentials, or authentication headers. Every page,
asset, and redirect is HTTPS-only and revalidated against private, loopback,
link-local, and reserved destinations. Bot challenges, login/paywall shells,
and abstract-only pages are not publishable articles. If no trusted exact-DOI
open source exists, the job asks for a PDF or saved HTML bundle instead of
attempting to bypass access controls.

## Manual layout repair

DOCX conversion preserves the source document's object order. Collected figure
plates therefore remain collected instead of being moved to the first textual
callout, which can be ambiguous for multi-panel and repeatedly cited figures.
In document edit mode, select a figure or table, choose **Move object**, then
choose a visible **Place here** line between paragraph blocks. The preview is
reversible until **Save changes** is selected. Image-only paragraphs and a
strongly adjacent `Figure`, `Fig.`, or `Table` caption move as one unit, including
rich caption math; structured figures and scrollable table wrappers remain
intact. Image drag-resizing and the object width/alignment controls remain
available before or after relocation.

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

Repair application always requires explicit reviewer approval. Only
high-confidence responsive sizing, overflow wrapping, safe SVG-semantic
restoration, and fixed-dimension removal backed by deterministic checks can use
the direct one-click path. Broader bounded CSS candidates require before/after
review and per-operation approval. Accepted operations use the normal document
edit engine while the initial version is published, and publication fails if
canonical text changes. Caption
associations, moves, semantic roles, alt text, prose, equations, citations,
numbers, and table cells remain reader-reviewed and cannot enter this repair
path.

### Actionable review

Raw model reports are grouped by issue and semantic object before they reach the
review screen. A repeated desktop/narrow or figure/child report is therefore one
issue with several pieces of evidence, not several independent errors. Each
issue is labeled **confirmed**, **needs verification**, **rejected**, or
**resolved**. A model report alone is never presented as deterministic
corroboration. Outline excerpts, flattened table text, and screenshot edges are
locator evidence rather than proof of missing or clipped content.

Before publishing, a reader can record a false-positive verdict, defer an issue
to document edit mode, or leave an instruction and private note. Selected issues
can be rechecked against their exact stored evidence, or sent together to the
repair planner. Notes are data supplied to the planner; they cannot override the
repair contract. Rebuilding the review re-sanitizes the immutable converted
bundle and regenerates measurements and evidence, which is the correct remedy
when a sanitizer improvement fixes the derivative itself.

Repairs are revisioned candidates, never source-file mutations. Small structured
operations such as clearing genuinely fixed dimensions or restoring validated
SVG viewport and marker semantics can use a one-click path. Broader presentation
changes are limited to an allowlisted JSON style envelope. In both cases the
candidate must preserve canonical scholarly text and the external asset
inventory. The reader can compare original and candidate previews, approve only
selected operations, and revert the active repair revision. Publication applies
only that explicitly accepted revision; dismissed findings and model proposals
cannot alter the article by themselves.

The **Remember response** action creates an editable reviewer-policy rule for a
bounded scope such as issue category, evidence kind, source kind, or publisher
domain. Rules can require stronger evidence, lower unsupported findings' review
priority, increase scrutiny, or add context. They calibrate future prompts but
never auto-dismiss a finding, serve as evidence, or bypass candidate validation.
Rules are visible and removable in Settings.

The import dialog discloses that visible derivatives, PDF/source pages, fetched
article excerpts, and labeled screenshots may be sent to OpenAI when source
comparison is enabled. Original archives, hidden OOXML fields, and Zotero JSON
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

PDF deployment acceptance exports both manuscripts to PDF and checks every
page, correct title and reading order, seven figures, two tables, captions, and
visually preserved equations. A recorded PMC/JATS fixture is the deterministic
web-import gate; publisher URLs remain live smoke tests because access policies
and bot filters can change independently of AfterDraft.

## Operations and backup

The sidecar is part of the AfterDraft Compose lifecycle but stores no durable
state. SQLite, normalized sources/assets, review evidence retained with each
import job, and final edits remain in `afterdraft-data`; the existing backup/restore unit is
therefore unchanged. Back up before migrations, deploy both containers from one
committed revision, verify the app and worker health endpoints, import both
private fixtures, then confirm the service through the existing Tailscale HTTPS
route.
