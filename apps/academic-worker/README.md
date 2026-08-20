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
