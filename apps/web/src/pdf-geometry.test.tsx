import {describe, expect, it} from 'vitest';
import {clipPdfQuad, normalizePdfRotation, pageSearchResults, pdfQuadToViewport, viewportRectToPdfQuad} from './pdf-geometry.js';

describe('PDF source geometry and indexed search', () => {
  it('round-trips a region through scaling, rotation, and a nonzero page origin', () => {
    const viewport = {
      convertToViewportPoint: (x: number, y: number) => [(y - 40) * 2, (x - 30) * 2],
      convertToPdfPoint: (x: number, y: number) => [y / 2 + 30, x / 2 + 40],
    };
    const quad = viewportRectToPdfQuad({left: 180, top: 240, right: 260, bottom: 300}, {left: 100, top: 200}, viewport);
    expect(quad).toEqual([50, 80, 50, 120, 80, 120, 80, 80]);
    expect(pdfQuadToViewport(quad, viewport)).toEqual([[80, 40], [160, 40], [160, 100], [80, 100]]);
  });
  it('clips a text item along its own axes, including rotated text', () => {
    expect(clipPdfQuad([10, 100, 10, 200, 30, 200, 30, 100], 0.2, 0.6)).toEqual([10, 120, 10, 160, 30, 160, 30, 120]);
    expect(normalizePdfRotation(-90)).toBe(270);
  });
  it('keeps search offsets in the exact page index including repeated passages', () => {
    expect(pageSearchResults([{page: 2, text: 'AI is here. AI once more.'}, {page: 8, text: 'AI later.'}], 'AI')).toEqual([
      {page: 2, start: 0, end: 2}, {page: 2, start: 12, end: 14}, {page: 8, start: 0, end: 2},
    ]);
    expect(pageSearchResults([{page: 1, text: 'content'}], ' ')).toEqual([]);
    expect(pageSearchResults([{page: 1, text: 'İ AI'}], 'AI')).toEqual([{page: 1, start: 2, end: 4}]);
  });
});
