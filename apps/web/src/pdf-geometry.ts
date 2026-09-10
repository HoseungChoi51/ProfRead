export type PdfPoint = [number, number];
export type PdfQuad = [number, number, number, number, number, number, number, number];
export type PdfView = [number, number, number, number];
export interface PdfViewportTransform {
  convertToPdfPoint(x: number, y: number): number[];
  convertToViewportPoint(x: number, y: number): number[];
}

/** Saved coordinates are PDF user-space points; screen pixels are transient. */
export function viewportRectToPdfQuad(
  rect: {left: number; top: number; right: number; bottom: number},
  origin: {left: number; top: number},
  viewport: PdfViewportTransform,
): PdfQuad {
  return [[rect.left, rect.top], [rect.right, rect.top], [rect.right, rect.bottom], [rect.left, rect.bottom]]
    .flatMap(([x, y]) => viewport.convertToPdfPoint(x! - origin.left, y! - origin.top)) as PdfQuad;
}

export function pdfQuadToViewport(quad: readonly number[], viewport: PdfViewportTransform): PdfPoint[] {
  return Array.from({length: 4}, (_, index) => viewport.convertToViewportPoint(quad[index * 2]!, quad[index * 2 + 1]!) as PdfPoint);
}

export function quadBounds(quad: readonly number[]): {left: number; top: number; right: number; bottom: number} {
  const xs = quad.filter((_, index) => index % 2 === 0);
  const ys = quad.filter((_, index) => index % 2 !== 0);
  return {left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys)};
}

export function clipPdfQuad(quad: readonly number[], startRatio: number, endRatio: number): PdfQuad {
  const start = Math.max(0, Math.min(1, startRatio)), end = Math.max(start, Math.min(1, endRatio));
  const interpolate = (a: number, b: number, ratio: number) => a + (b - a) * ratio;
  return [
    interpolate(quad[0]!, quad[2]!, start), interpolate(quad[1]!, quad[3]!, start),
    interpolate(quad[0]!, quad[2]!, end), interpolate(quad[1]!, quad[3]!, end),
    interpolate(quad[6]!, quad[4]!, end), interpolate(quad[7]!, quad[5]!, end),
    interpolate(quad[6]!, quad[4]!, start), interpolate(quad[7]!, quad[5]!, start),
  ];
}

export function normalizePdfRotation(rotation: number): number {
  return ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
}

export function clampPdfZoom(zoom: number): number {
  return Math.max(0.25, Math.min(4, Number.isFinite(zoom) ? zoom : 1));
}

export function pageSearchResults(pages: Array<{page: number; text: string}>, query: string): Array<{page: number; start: number; end: number}> {
  const needle = query.trim();
  if (!needle) return [];
  const results: Array<{page: number; start: number; end: number}> = [];
  for (const page of pages) {
    const expression = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    for (const match of page.text.matchAll(expression)) {
      if (results.length >= 1000) break;
      results.push({page: page.page, start: match.index, end: match.index + match[0].length});
    }
    if (results.length >= 1000) break;
  }
  return results;
}
