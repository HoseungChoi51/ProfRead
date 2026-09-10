# ProfRead academic worker

This internal, credential-free service isolates native document converters and
Chromium from the application process. Compose exposes it only on the private
`academic-worker` network; it has no host port or API credentials.

Endpoints accept a raw request body and return a ZIP containing `manifest.json`
plus conversion or QA evidence files:

- `GET /health`
- `POST /v1/convert/docx?filename=paper.docx&reference=true&referencePages=60`
- `POST /v1/convert/tex?filename=project.zip&entry=main.tex`
- `POST /v1/convert/jats?filename=article.xml`
- `POST /v1/convert/pdf?filename=paper.pdf&reference=true&referencePages=60`
- `POST /v1/render?maxObjects=120`
- `POST /v1/render/pdf?filename=paper.pdf&pages=60`

The request ceiling is 100 MiB, matching the public upload boundary.

PDF reading has a separate path that does not reconstruct HTML:

- POST /v1/pdf/prepare?filename=issue.pdf&pageStart=22&pageEnd=28 returns reading.pdf and pdf-index.json. It preserves the original source hash and original one-based page mapping; page text is initially pending.
- POST /v1/pdf/index?pageStart=1&pageEnd=4&sourcePageStart=22&ocr=auto&language=eng accepts the prepared derivative. A batch contains at most four pages; the application persists per-page checkpoints. OCR modes are auto, force, and off; languages are eng and eng+kor.
- POST /v1/pdf/crop?page=1&x=50&y=100&width=200&height=150 accepts the prepared derivative and returns crop.png plus verified crop.json metadata.

The bundle operations are pdf-prepare, pdf-index, and pdf-crop. The manifest source
hash always identifies the submitted bytes. Index batch hashes therefore identify
the derivative; callers retain the original source hash and page count from the
prepare result. SourcePageStart is the original first page of the entire
derivative, not the first page of the current batch.

Geometry uses unrotated PDF user space, including CropBox offsets. Native items
retain exact PDF.js strings, item indexes, transforms, UTF-16 offsets, and quads;
the separately normalized transcript is only for search/context. The browser and
worker pin PDF.js to the same version. Original page labels are retained when the
PDF supplies them; printed page numbers are never inferred from an offset.

Tesseract runs locally with packaged English/Korean data and two threads.
Missing, unusable, or heavily tracked native text triggers page OCR. Low-confidence
automatic segmentation receives a bounded single-block retry. A page gets at most
45 seconds for rasterization and 45 seconds per OCR attempt. Raster dimensions
are capped at 4,200 pixels, scratch rasters are removed per page, and indexing
failures remain explicit per-page results. OCR confidence is not an accuracy
guarantee. Page images and the immutable PDF remain available for verification.

The HTML renderer deliberately blocks scripts and every external, relative, and
`file:` resource. Callers must send self-contained HTML and use `data:` URLs for
images and fonts. It captures desktop (1440x1000) and narrow (768x1400) evidence,
DOM overflow metrics, console/resource failures, and labelled object crops.

The standalone PDF converter accepts at most 100 pages/100 MiB, rejects
encrypted or incomplete conversion, reconstructs positioned native text, and
publishes every page as a folded 144-DPI JPEG fallback. Optional model review
reuses those page assets rather than duplicating them. The separate PDF evidence
renderer rasterizes at most 60 pages, caps any page at 64 MiB, and caps the
complete PNG/ZIP output at 220 MiB. The container supplies Pandoc, LaTeXML,
LibreOffice, Poppler, Chromium, and Noto fonts. Child tools receive a minimal
environment rooted in worker-only `/tmp` directories.
