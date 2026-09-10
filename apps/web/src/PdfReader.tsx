import {forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState} from 'react';
import type {CSSProperties, PointerEvent as ReactPointerEvent} from 'react';
import type {PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask} from 'pdfjs-dist';
import type {PdfSelector, PdfPageItem, PdfPage as PdfPageInfo, PdfManifest} from '@profread/shared';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {api} from './api.js';
import {clampPdfZoom, clipPdfQuad, normalizePdfRotation, pageSearchResults, pdfQuadToViewport, quadBounds, viewportRectToPdfQuad} from './pdf-geometry.js';
import './pdf-reader.css';

export type {PdfSelector, PdfPageItem, PdfPageInfo, PdfManifest};
export type PdfProgress = {page: number; offsetRatio: number; zoom: number; rotation: number};
export type PdfMarker = {id: string; selector: PdfSelector; kind?: string; label?: string; note?: string | null; color?: string; status?: string};
export type PdfSelection = {selector: PdfSelector; rect: {left: number; top: number; width: number; height: number}};
export type PdfReaderHandle = {reveal: (selector: PdfSelector) => void; clearSelection: () => void; refreshSelection: () => void};

export function isPdfSelector(value: unknown): value is PdfSelector {
  return Boolean(value && typeof value === 'object' && 'kind' in value && ['pdf-text', 'pdf-region'].includes(String(value.kind)));
}

export function pdfPageLabel(page: PdfPageInfo): string {
  return page.label ? `Page ${page.label} · PDF ${page.sourcePage}` : `PDF page ${page.sourcePage}`;
}

function screenBounds(points: Array<[number, number]>) {
  return quadBounds(points.flat());
}

export function pdfTextSelector(manifest: PdfManifest, ranges: Array<{page: number; start: number; end: number}>): PdfSelector | null {
  const segments: PdfSelector['segments'] = [];
  for (const range of ranges) {
    const page = manifest.pages.find(item => item.page === range.page);
    if (!page || range.start < 0 || range.end > page.text.length || range.end <= range.start) continue;
    const quads = page.items.filter(item => item.end > range.start && item.start < range.end && item.end > item.start)
      .map(item => clipPdfQuad(item.quad, (Math.max(range.start, item.start) - item.start) / (item.end - item.start), (Math.min(range.end, item.end) - item.start) / (item.end - item.start)));
    if (quads.length) segments.push({page: range.page, quads, startOffset: range.start, endOffset: range.end, exact: page.text.slice(range.start, range.end)});
  }
  if (!segments.length) return null;
  return {kind: 'pdf-text', representationId: manifest.representationId, sourceHash: manifest.sourceHash, extractionRevision: manifest.extractionRevision, exact: segments.map(segment => segment.exact).join('\n'), segments};
}

function pageDimensions(page: PdfPageInfo, zoom: number, rotation: number) {
  const rotated = normalizePdfRotation(page.rotation + rotation) % 180 !== 0;
  const width = page.view[2] - page.view[0], height = page.view[3] - page.view[1];
  return {width: (rotated ? height : width) * zoom, height: (rotated ? width : height) * zoom};
}

export const PdfReader = forwardRef<PdfReaderHandle, {
  representationId: string;
  title: string;
  markers: PdfMarker[];
  onSelection: (selection: PdfSelection | null) => void;
  onGeometry: (rect: PdfSelection['rect']) => void;
  onAnchorClick: (anchorId: string) => void;
  onProgress: (progress: PdfProgress) => void;
  onError: (message: string) => void;
  onReady?: () => void;
  onIndexChange?: (source: Pick<PdfManifest, 'extractionRevision' | 'status'>) => void;
}>(function PdfReader({representationId, title, markers, onSelection, onGeometry, onAnchorClick, onProgress, onError, onReady, onIndexChange}, ref) {
  const [manifest, setManifest] = useState<PdfManifest | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [loadingError, setLoadingError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [regionMode, setRegionMode] = useState(false);
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [revealed, setRevealed] = useState<PdfSelector | null>(null);
  const [ocrLanguage, setOcrLanguage] = useState<'eng' | 'eng+kor'>('eng');
  const [indexBusy, setIndexBusy] = useState(false);
  const [indexMessage, setIndexMessage] = useState('');
  const viewport = useRef<HTMLDivElement>(null);
  const pages = useRef(new Map<number, {element: HTMLElement; viewport: PageViewport}>());
  const currentSelection = useRef<PdfSelector | null>(null);
  const pendingReveal = useRef<PdfSelector | null>(null);
  const restoreProgress = useRef<Partial<PdfProgress> | null>(null);
  const callbacks = useRef({onSelection, onGeometry, onAnchorClick, onProgress, onError, onReady, onIndexChange});
  callbacks.current = {onSelection, onGeometry, onAnchorClick, onProgress, onError, onReady, onIndexChange};
  const searchResults = useMemo(() => pageSearchResults(manifest?.pages ?? [], query), [manifest, query]);
  const visibleMarkers = useMemo(() => markers.filter(marker => marker.selector.representationId === representationId && marker.status !== 'unmatched'), [markers, representationId]);

  const goToPage = useCallback((page: number, ratio = 0) => {
    const target = viewport.current?.querySelector<HTMLElement>(`[data-pdf-page="${page}"]`);
    const container = viewport.current;
    if (!target || !container) return;
    const bounds = target.getBoundingClientRect(), area = container.getBoundingClientRect();
    container.scrollTop += bounds.top - area.top + ratio * bounds.height;
    setPageNumber(page);
    setPageInput(String(page));
  }, []);

  const refreshSelection = useCallback(() => {
    const selector = currentSelection.current, first = selector?.segments[0];
    const page = first && pages.current.get(first.page);
    if (!first || !page || !first.quads.length) return;
    const bounds = screenBounds(first.quads.flatMap(quad => pdfQuadToViewport(quad, page.viewport)));
    const origin = page.element.getBoundingClientRect();
    callbacks.current.onGeometry({left: origin.left + bounds.left, top: origin.top + bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top});
  }, []);

  const reveal = useCallback((selector: PdfSelector) => {
    if (selector.representationId !== representationId) return;
    currentSelection.current = selector;
    pendingReveal.current = selector;
    setRevealed(selector);
    const first = selector.segments[0];
    if (!first) return;
    goToPage(first.page);
    requestAnimationFrame(() => {
      const page = pages.current.get(first.page), container = viewport.current;
      if (!page || !container) return;
      const bounds = screenBounds(first.quads.flatMap(quad => pdfQuadToViewport(quad, page.viewport)));
      const origin = page.element.getBoundingClientRect(), area = container.getBoundingClientRect();
      container.scrollTop += origin.top + bounds.top - area.top - Math.min(100, area.height / 4);
      pendingReveal.current = null;
      refreshSelection();
    });
  }, [goToPage, refreshSelection, representationId]);

  useImperativeHandle(ref, () => ({reveal, refreshSelection, clearSelection: () => {
    currentSelection.current = null;
    pendingReveal.current = null;
    setRevealed(null);
    window.getSelection()?.removeAllRanges();
  }}), [reveal, refreshSelection]);

  useEffect(() => {
    const controller = new AbortController();
    let task: ReturnType<typeof import('pdfjs-dist')['getDocument']> | undefined;
    setManifest(null); setPdf(null); setLoadingError(''); setRevealed(null);
    currentSelection.current = null;
    pages.current.clear();
    void (async () => {
      try {
        const next = await api<PdfManifest>(`/api/representations/${representationId}/manifest`, {signal: controller.signal});
        if (controller.signal.aborted) return;
        setManifest(next);
        setOcrLanguage(next.ocrLanguage);
        setZoom(clampPdfZoom(next.progress?.zoom ?? 1));
        setRotation(normalizePdfRotation(next.progress?.rotation ?? 0));
        restoreProgress.current = next.progress ?? {page: 1, offsetRatio: 0};
        const pdfjs = await import('pdfjs-dist');
        if (controller.signal.aborted) return;
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        const assets = '/assets/pdfjs-6.3.289/';
        task = pdfjs.getDocument({url: next.url || `/api/representations/${representationId}/pdf`, withCredentials: true, enableXfa: false, useSystemFonts: false, cMapUrl: assets + 'cmaps/', cMapPacked: true, standardFontDataUrl: assets + 'standard_fonts/', wasmUrl: assets + 'wasm/', iccUrl: assets + 'iccs/'});
        const document = await task.promise;
        if (!controller.signal.aborted) setPdf(document);
      } catch (error) {
        if (!controller.signal.aborted) setLoadingError((error as Error).message || 'Could not open PDF');
      }
    })();
    return () => {controller.abort(); void task?.destroy();};
  }, [representationId]);

  useEffect(() => {
    if (manifest) callbacks.current.onIndexChange?.({extractionRevision: manifest.extractionRevision, status: manifest.status});
  }, [manifest?.extractionRevision, manifest?.status]);

  async function indexPage(force: boolean) {
    setIndexBusy(true); setIndexMessage('');
    try {
      await api(`/api/representations/${representationId}/ocr`, {method: 'POST', body: JSON.stringify({page: pageNumber, force, ocrLanguage})});
      setManifest(await api<PdfManifest>(`/api/representations/${representationId}/manifest`));
      setIndexMessage(`${force ? 'OCR' : 'Text extraction'} queued for this page. The original PDF and saved selections remain unchanged.`);
    } catch (error) {callbacks.current.onError((error as Error).message);}
    finally {setIndexBusy(false);}
  }
  async function cancelIndexing() {
    setIndexBusy(true); setIndexMessage('');
    try {
      await api(`/api/representations/${representationId}/index/cancel`, {method: 'POST', body: JSON.stringify({})});
      setManifest(await api<PdfManifest>(`/api/representations/${representationId}/manifest`));
      setIndexMessage('Indexing cancelled. Completed pages and saved selections are preserved.');
    } catch (error) {callbacks.current.onError((error as Error).message);}
    finally {setIndexBusy(false);}
  }

  useEffect(() => {
    if (!manifest || !['preparing', 'indexing'].includes(manifest.status)) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void api<PdfManifest>(`/api/representations/${representationId}/manifest`, {signal: controller.signal})
        .then(next => {if (!controller.signal.aborted) setManifest(next);})
        .catch(error => {if (!controller.signal.aborted) callbacks.current.onError(error.message);});
    }, 2500);
    return () => {controller.abort(); clearInterval(timer);};
  }, [manifest?.status, representationId]);

  useEffect(() => {
    if (!pdf || !manifest) return;
    const progress = restoreProgress.current;
    if (!progress) return;
    const frame = requestAnimationFrame(() => {
      goToPage(Math.min(manifest.pages.length, Math.max(1, progress.page ?? 1)), progress.offsetRatio ?? 0);
      restoreProgress.current = null;
      callbacks.current.onReady?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [goToPage, manifest, pdf]);

  useEffect(() => {
    const element = viewport.current;
    if (!element || !manifest) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const area = element.getBoundingClientRect();
        const pageElements = [...element.querySelectorAll<HTMLElement>('[data-pdf-page]')];
        const active = pageElements.find(page => page.getBoundingClientRect().bottom > area.top + 40) ?? pageElements.at(-1);
        if (!active) return;
        const bounds = active.getBoundingClientRect(), page = Number(active.dataset.pdfPage);
        const offsetRatio = Math.min(1, Math.max(0, (area.top - bounds.top) / bounds.height));
        setPageNumber(page); setPageInput(String(page));
        callbacks.current.onProgress({page, offsetRatio, zoom, rotation});
        refreshSelection();
      });
    };
    element.addEventListener('scroll', update, {passive: true});
    update();
    return () => {element.removeEventListener('scroll', update); cancelAnimationFrame(frame);};
  }, [manifest, refreshSelection, rotation, zoom]);

  const acceptSelection = useCallback((selection: PdfSelection) => {
    currentSelection.current = selection.selector;
    setRevealed(selection.selector);
    callbacks.current.onSelection(selection);
  }, []);

  function captureTextSelection() {
    if (!manifest || regionMode) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const area = viewport.current;
    if (!area?.contains(range.startContainer) || !area.contains(range.endContainer)) return;
    const selected: Array<{page: number; start: number; end: number}> = [];
    for (const element of area.querySelectorAll<HTMLElement>('[data-pdf-text-item]')) {
      if (!range.intersectsNode(element)) continue;
      const page = Number(element.dataset.page), itemStart = Number(element.dataset.start), itemEnd = Number(element.dataset.end);
      const spanRange = document.createRange();
      spanRange.selectNodeContents(element);
      let start = itemStart, end = itemEnd;
      if (element.contains(range.startContainer)) {
        spanRange.setEnd(range.startContainer, range.startOffset);
        start += spanRange.toString().length;
      }
      if (element.contains(range.endContainer)) {
        spanRange.selectNodeContents(element);
        spanRange.setEnd(range.endContainer, range.endOffset);
        end = itemStart + spanRange.toString().length;
      }
      if (end <= start) continue;
      const existing = selected.find(item => item.page === page);
      if (existing) {existing.start = Math.min(existing.start, start); existing.end = Math.max(existing.end, end);}
      else selected.push({page, start, end});
    }
    const selector = pdfTextSelector(manifest, selected);
    if (!selector?.exact.trim()) return;
    const rect = range.getBoundingClientRect();
    acceptSelection({selector, rect: {left: rect.left, top: rect.top, width: rect.width, height: rect.height}});
  }

  function changeZoom(next: number) {
    const element = viewport.current?.querySelector<HTMLElement>(`[data-pdf-page="${pageNumber}"]`);
    const area = viewport.current?.getBoundingClientRect(), bounds = element?.getBoundingClientRect();
    const ratio = area && bounds ? Math.max(0, (area.top - bounds.top) / bounds.height) : 0;
    setZoom(clampPdfZoom(next));
    requestAnimationFrame(() => {goToPage(pageNumber, ratio); refreshSelection();});
  }

  function fitWidth() {
    const page = manifest?.pages.find(item => item.page === pageNumber), area = viewport.current;
    if (!page || !area) return;
    const dimensions = pageDimensions(page, 1, rotation);
    changeZoom((area.clientWidth - 56) / dimensions.width);
  }

  function showSearch(index: number) {
    if (!manifest || !searchResults.length) return;
    const next = (index + searchResults.length) % searchResults.length;
    setMatchIndex(next);
    const match = searchResults[next]!;
    const selector = pdfTextSelector(manifest, [match]);
    if (selector) reveal(selector);
  }

  if (loadingError) return <div className="pdf-reader-error" role="alert"><p>{loadingError}</p><p>The original PDF can be opened again when preparation completes.</p></div>;
  if (!manifest) return <div className="pdf-reader-loading" role="status">Opening PDF…</div>;

  return <div className="pdf-reader" aria-label={`PDF reader: ${title}`}>
    <div className="pdf-toolbar" role="toolbar" aria-label="PDF navigation">
      <div className="pdf-toolbar-group">
        <button title="Previous page" aria-label="Previous page" disabled={pageNumber <= 1} onClick={() => goToPage(pageNumber - 1)}>‹</button>
        <form onSubmit={event => {event.preventDefault(); goToPage(Math.min(manifest.pages.length, Math.max(1, Number(pageInput) || 1)));}}>
          <label className="sr-only" htmlFor="pdf-page-number">PDF reader page</label><input id="pdf-page-number" inputMode="numeric" value={pageInput} onChange={event => setPageInput(event.target.value)} />
          <span> / {manifest.pages.length}</span>
        </form>
        <button title="Next page" aria-label="Next page" disabled={pageNumber >= manifest.pages.length} onClick={() => goToPage(pageNumber + 1)}>›</button>
      </div>
      <div className="pdf-toolbar-group"><button aria-label="Zoom out" disabled={zoom <= 0.25} onClick={() => changeZoom(zoom / 1.2)}>−</button><span className="pdf-zoom-label">{Math.round(zoom * 100)}%</span><button aria-label="Zoom in" disabled={zoom >= 4} onClick={() => changeZoom(zoom * 1.2)}>+</button><button onClick={fitWidth}>Fit width</button><button aria-label="Rotate PDF clockwise" onClick={() => {setRotation(value => normalizePdfRotation(value + 90)); requestAnimationFrame(() => goToPage(pageNumber));}}>Rotate</button></div>
      <button aria-pressed={regionMode} className={regionMode ? 'active' : ''} onClick={() => {setRegionMode(value => !value); window.getSelection()?.removeAllRanges();}}>Select region</button>
      <form className="pdf-search" onSubmit={event => {event.preventDefault(); showSearch(matchIndex);}}><input aria-label="Search PDF text" placeholder="Find in PDF" value={query} onChange={event => {setQuery(event.target.value); setMatchIndex(0);}}/><span aria-live="polite">{query.trim() ? `${searchResults.length ? matchIndex + 1 : 0}/${searchResults.length}` : ''}</span><button aria-label="Previous search result" disabled={!searchResults.length} type="button" onClick={() => showSearch(matchIndex - 1)}>‹</button><button aria-label="Next search result" disabled={!searchResults.length} type="button" onClick={() => showSearch(matchIndex + 1)}>›</button></form>
      <details className="pdf-text-tools"><summary>Text tools</summary><div><label>OCR language <select aria-label="PDF OCR language" value={ocrLanguage} disabled={indexBusy} onChange={event => setOcrLanguage(event.target.value as 'eng' | 'eng+kor')}><option value="eng">English</option><option value="eng+kor">English + Korean</option></select></label><button disabled={indexBusy || manifest.status === 'indexing'} onClick={() => void indexPage(false)}>Retry this page</button><button disabled={indexBusy || manifest.status === 'indexing'} onClick={() => void indexPage(true)}>OCR this page</button>{manifest.status === 'indexing' && <button disabled={indexBusy} onClick={() => void cancelIndexing()}>Cancel indexing</button>}<small>OCR updates searchable text, not the PDF image. Existing selections keep their saved extraction revision.</small></div></details>
    </div>
    {indexMessage && <p className="pdf-mode-hint" role="status">{indexMessage}</p>}
    {regionMode && <p className="pdf-mode-hint" role="status">Drag a rectangle around a figure, equation, or passage. Select region again to return to text selection.</p>}
    {!pdf && <div className="pdf-loading-overlay" role="status">Loading original pages…</div>}
    <div ref={viewport} className={`pdf-viewport${regionMode ? ' pdf-region-mode' : ''}`} tabIndex={0} aria-label="PDF pages" onMouseUp={captureTextSelection} onKeyUp={event => {if (event.key === 'Shift' || event.key.startsWith('Arrow')) captureTextSelection();}}>
      {manifest.pages.map(page => <PdfPage key={`${representationId}:${page.page}`} page={page} pdf={pdf} zoom={zoom} rotation={rotation} scrollRoot={viewport.current} regionMode={regionMode} manifest={manifest} markers={visibleMarkers.filter(marker => marker.selector.segments.some(segment => segment.page === page.page))} revealed={revealed} onSelection={acceptSelection} onAnchorClick={onAnchorClick} onReady={(element, pageViewport) => {
        pages.current.set(page.page, {element, viewport: pageViewport});
        if (pendingReveal.current?.segments[0]?.page === page.page) reveal(pendingReveal.current);
        else refreshSelection();
      }} onUnavailable={() => pages.current.delete(page.page)} onNavigate={goToPage}/>) }
    </div>
  </div>;
});

type PdfAnnotation = {id: string; rect: number[]; url?: string; dest?: string | unknown[]};

function PdfPage({page, pdf, zoom, rotation, scrollRoot, regionMode, manifest, markers, revealed, onSelection, onAnchorClick, onReady, onUnavailable, onNavigate}: {
  page: PdfPageInfo; pdf: PDFDocumentProxy | null; zoom: number; rotation: number; scrollRoot: HTMLElement | null; regionMode: boolean; manifest: PdfManifest; markers: PdfMarker[]; revealed: PdfSelector | null;
  onSelection: (selection: PdfSelection) => void; onAnchorClick: (id: string) => void; onReady: (element: HTMLElement, viewport: PageViewport) => void; onUnavailable: () => void; onNavigate: (page: number) => void;
}) {
  const shell = useRef<HTMLElement>(null), surface = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(page.page === 1);
  const [pageViewport, setPageViewport] = useState<PageViewport | null>(null);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [renderError, setRenderError] = useState('');
  const [rendered, setRendered] = useState(false);
  const [drag, setDrag] = useState<{startX: number; startY: number; x: number; y: number} | null>(null);
  const dragRef = useRef<typeof drag>(null);
  const callbacks = useRef({onReady, onUnavailable}); callbacks.current = {onReady, onUnavailable};
  const dimensions = pageDimensions(page, zoom, rotation);

  useEffect(() => {
    if (!shell.current || typeof IntersectionObserver === 'undefined') {setVisible(true); return;}
    const observer = new IntersectionObserver(entries => {setVisible(entries.some(entry => entry.isIntersecting));}, {root: scrollRoot, rootMargin: '1000px 300px'});
    observer.observe(shell.current);
    return () => observer.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    if (!visible || !pdf || !canvas.current || !surface.current) return;
    let cancelled = false, render: RenderTask | undefined, documentPage: PDFPageProxy | undefined;
    setRenderError('');
    setRendered(false);
    void (async () => {
      try {
        documentPage = await pdf.getPage(page.page);
        if (cancelled || !canvas.current || !surface.current) return;
        const next = documentPage.getViewport({scale: zoom, rotation: normalizePdfRotation(page.rotation + rotation)});
        setPageViewport(next);
        const density = Math.min(2, window.devicePixelRatio || 1), target = canvas.current;
        target.width = Math.ceil(next.width * density); target.height = Math.ceil(next.height * density);
        target.style.width = `${next.width}px`; target.style.height = `${next.height}px`;
        const context = target.getContext('2d');
        if (!context) throw new Error('Your browser could not create a PDF page canvas');
        render = documentPage.render({canvas: target, canvasContext: context, viewport: next, transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0]});
        await render.promise;
        if (cancelled) return;
        setRendered(true);
        const links = await documentPage.getAnnotations({intent: 'display'});
        if (cancelled) return;
        setAnnotations(links.filter(item => item.subtype === 'Link' && Array.isArray(item.rect)) as PdfAnnotation[]);
        callbacks.current.onReady(surface.current, next);
      } catch (error) {
        if (!cancelled && (error as Error).name !== 'RenderingCancelledException') setRenderError((error as Error).message);
      }
    })();
    return () => {cancelled = true; render?.cancel(); callbacks.current.onUnavailable();};
  }, [page.page, page.rotation, pdf, rotation, visible, zoom]);

  function pointerStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (!regionMode || !pageViewport || event.button !== 0) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect(), x = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)), y = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top));
    const next = {startX: x, startY: y, x, y}; dragRef.current = next; setDrag(next);
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    const bounds = event.currentTarget.getBoundingClientRect(), next = {...dragRef.current, x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)), y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top))};
    dragRef.current = next; setDrag(next);
  }
  function pointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const current = dragRef.current; dragRef.current = null; setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!current || !pageViewport || Math.abs(current.x - current.startX) < 4 || Math.abs(current.y - current.startY) < 4) return;
    const origin = event.currentTarget.getBoundingClientRect(), left = origin.left + Math.min(current.startX, current.x), top = origin.top + Math.min(current.startY, current.y), width = Math.abs(current.x - current.startX), height = Math.abs(current.y - current.startY);
    const quad = viewportRectToPdfQuad({left, top, right: left + width, bottom: top + height}, origin, pageViewport);
    const selector: PdfSelector = {kind: 'pdf-region', representationId: manifest.representationId, sourceHash: manifest.sourceHash, extractionRevision: manifest.extractionRevision, exact: '', segments: [{page: page.page, quads: [quad]}]};
    onSelection({selector, rect: {left, top, width, height}});
  }
  async function followLink(annotation: PdfAnnotation) {
    if (!pdf || !annotation.dest) return;
    const destination = typeof annotation.dest === 'string' ? await pdf.getDestination(annotation.dest) : annotation.dest;
    if (!destination?.length) return;
    const target = destination[0];
    const index = typeof target === 'number' ? target : await pdf.getPageIndex(target as {num: number; gen: number});
    onNavigate(index + 1);
  }
  const currentSegments = revealed?.segments.filter(segment => segment.page === page.page) ?? [];
  return <section ref={shell} data-pdf-page={page.page} className="pdf-page-shell" style={{width: dimensions.width, minHeight: dimensions.height + 32}} aria-label={pdfPageLabel(page)}>
    <header className="pdf-page-label"><span>{pdfPageLabel(page)}</span>{page.textStatus === 'ocr' && <span>OCR text{page.confidence !== undefined ? ` · ${Math.round(page.confidence <= 1 ? page.confidence * 100 : page.confidence)}% confidence` : ''}</span>}{['pending', 'image-only', 'failed'].includes(page.textStatus) && <span>{page.textStatus === 'pending' ? 'Text indexing…' : 'Use region selection for this page'}</span>}</header>
    <div ref={surface} className="pdf-page-surface" style={dimensions} onPointerDown={pointerStart} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={() => {dragRef.current = null; setDrag(null);}}>
      {visible && <canvas ref={canvas} data-rendered={rendered ? 'true' : 'false'} aria-label={pdfPageLabel(page)} />}
      {!visible && <div className="pdf-page-placeholder" />}
      {renderError && <p className="pdf-page-render-error" role="alert">{renderError}</p>}
      {visible && pageViewport && <>
        <div className="pdf-text-layer" aria-label={`Selectable text, ${pdfPageLabel(page)}`}>
          {page.items.map((item, index) => <PdfTextItem key={`${index}:${item.start}`} item={item} page={page.page} viewport={pageViewport}/>)}
        </div>
        <div className="pdf-native-annotation-layer">
          {annotations.map(annotation => {
            const rect = annotation.rect, points = [pageViewport.convertToViewportPoint(rect[0]!, rect[1]!), pageViewport.convertToViewportPoint(rect[2]!, rect[3]!)], bounds = quadBounds(points.flat()), style = {left: bounds.left, top: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top};
            const safeUrl = annotation.url && /^(https?:|mailto:)/i.test(annotation.url) ? annotation.url : null;
            if (safeUrl) return <a key={annotation.id} className="pdf-native-link" style={style} href={safeUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open link: ${safeUrl}`}/>;
            if (annotation.dest) return <button key={annotation.id} className="pdf-native-link" style={style} onClick={() => void followLink(annotation)} aria-label="Follow PDF reference"/>;
            return null;
          })}
        </div>
        <svg className="pdf-mark-layer" width={dimensions.width} height={dimensions.height} aria-hidden="true">
          {markers.flatMap(marker => marker.selector.segments.filter(segment => segment.page === page.page).flatMap((segment, segmentIndex) => segment.quads.map((quad, index) => <polygon key={`${marker.id}:${segmentIndex}:${index}`} className={`pdf-mark pdf-mark-${marker.kind || 'discussion'}`} points={pdfQuadToViewport(quad, pageViewport).map(point => point.join(',')).join(' ')}/>)))}
          {currentSegments.flatMap((segment, segmentIndex) => segment.quads.map((quad, index) => <polygon key={`selection:${segmentIndex}:${index}`} className="pdf-revealed-mark" points={pdfQuadToViewport(quad, pageViewport).map(point => point.join(',')).join(' ')}/>))}
        </svg>
        <div className="pdf-marker-buttons">{markers.map((marker, index) => {
          const segment = marker.selector.segments.find(item => item.page === page.page), quad = segment?.quads[0];
          if (!quad) return null;
          const bounds = screenBounds(pdfQuadToViewport(quad, pageViewport));
          return <button key={marker.id} className={`pdf-marker-button pdf-marker-${marker.kind || 'discussion'}`} style={{top: Math.max(0, bounds.top), right: -12 - (index % 3) * 7}} title={marker.note || marker.label || marker.selector.exact || 'Region discussion'} aria-label={`Open ${marker.kind || 'discussion'}: ${marker.note || marker.label || marker.selector.exact || pdfPageLabel(page)}`} onClick={() => onAnchorClick(marker.id)}>●</button>;
        })}</div>
      </>}
      {drag && <div className="pdf-region-draft" style={{left: Math.min(drag.startX, drag.x), top: Math.min(drag.startY, drag.y), width: Math.abs(drag.x - drag.startX), height: Math.abs(drag.y - drag.startY)}}/>}
    </div>
  </section>;
}

function PdfTextItem({item, page, viewport}: {item: PdfPageItem; page: number; viewport: PageViewport}) {
  const points = pdfQuadToViewport(item.quad, viewport), origin = points[0]!, across = points[1]!, down = points[3]!;
  const width = Math.hypot(across[0] - origin[0], across[1] - origin[1]), height = Math.hypot(down[0] - origin[0], down[1] - origin[1]);
  const text = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!text.current || !item.text) return;
    const measured = text.current.scrollWidth;
    text.current.style.transform = `scaleX(${measured ? width / measured : 1})`;
  }, [height, item.text, width]);
  const style: CSSProperties = {left: origin[0], top: origin[1], width, height, fontSize: height, transform: `matrix(${width ? (across[0] - origin[0]) / width : 1},${width ? (across[1] - origin[1]) / width : 0},${height ? (down[0] - origin[0]) / height : 0},${height ? (down[1] - origin[1]) / height : 1},0,0)`};
  return <span className="pdf-text-position" style={style}><span ref={text} data-pdf-text-item data-page={page} data-start={item.start} data-end={item.end} dir={item.dir === 'rtl' ? 'rtl' : 'ltr'}>{item.text}</span></span>;
}
