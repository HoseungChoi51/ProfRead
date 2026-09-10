# ProfRead: coexisting PDF reading

## Product contract

HTML remains the default import format. PDF uploads, direct PDF URLs, and arXiv
can instead open in an **Original PDF** reading view. Existing HTML articles with
a retained PDF can add that view without replacing their HTML or discussions.

The original PDF is immutable. Magazine imports require confirmation of the
article's physical page range; the reader uses a selected-page derivative while
the complete magazine remains archived. All citations preserve original physical
page numbers. Printed labels are shown only when the PDF actually supplies them.

## Implementation stages

1. **Identity and recovery:** rename display/package/configuration/deployment
   identities to ProfRead, retain legacy session/configuration compatibility,
   and verify a WAL-aware database copy before the production cutover.
2. **Sources and indexing:** introduce explicit HTML/PDF representations,
   authenticated range serving, retained source bytes, versioned page text,
   resumable indexing, and local English or English+Korean OCR.
3. **Reading and annotation:** render original pages with local PDF.js assets;
   select text or a visual region; save PDF-coordinate anchors; restore separate
   view positions; provide search, zoom, rotation, and page indexing controls.
4. **AI and study artifacts:** bind each discussion and nested follow-up to its
   source; generate verified image evidence on the server; validate citation IDs;
   keep HTML/PDF summaries separate; include every page in bounded map/reduce
   summaries when a single context is insufficient.
5. **Rollout gates:** run automated and browser tests, exercise the real Spectrum
   article, rehearse recovery on a copy of the existing library, validate the
   renamed HTML installation, then enable the user's PDF view and verify a new
   accepted backup and isolated restore.

Stages 1–4 are implemented on `agent/profread-pdf-reader`. Production/recovery
acceptance is recorded separately in the infrastructure deployment record; this
document is not evidence that a cutover has already happened.

## Source and interaction rules

- PDF anchors contain representation ID, original source hash, extraction
  revision, physical reader pages, unrotated PDF-space quads, and exact UTF-16
  text offsets when text is selected. OCR creates new derivatives, never rewrites
  old quotations or anchors.
- An HTML re-import does not move PDF discussions to different source bytes.
  Historical PDF views remain accessible and source-pinned.
- Pending or unreliable text does not prevent visual-region questions. OCR
  confidence below 70 or extraction errors require image evidence; confidence is
  not an accuracy guarantee. Retry and forced OCR are explicit user operations.
- Whole-document summaries reject incomplete indexing unless partial coverage
  is explicitly requested. Long sources are mapped and reduced without dropping
  source tails. Work/context limits fail visibly instead of silently truncating.
- Text coverage is not exhaustive visual coverage. Only attached images are
  inspected; other figures on text-bearing pages may not enter a summary.
- PDF reading does not offer source edits or Document Writer. Exports are the
  unchanged selected source PDF and separate HTML/Markdown/PDF study notes;
  embedded PDF annotation export is not part of this release.

## Acceptance fixture and checks

The supplied `09_Spectrum_26-med.pdf` is a 72-page magazine. The requested
“What it means to be a mathematician when AI does the math” occupies physical
pages **22–28** (printed 20–26). Its illustration-only page 23 must remain usable
even when OCR produces unreliable text. The test fixture is local and is not
checked into Git or sent in full to an AI provider.

Reproducible checks include `npm test`, `npm run typecheck`, `npm run lint`,
`npm run build`, the isolated `scripts/pdf-ingest-smoke.mjs` test, and the real
Chrome reader checks under `apps/web/scripts/`. The worker's container tests
exercise both English and Korean OCR; host-only tests skip OCR if Tesseract is
not installed.

See [the rename migration runbook](profread-migration.md) for exact paths,
backup/cutover constraints, and rollback rules. The previous volume and backup
history are preserved; switching back after new writes requires a compatible
recovery snapshot, not merely restarting an old container.
