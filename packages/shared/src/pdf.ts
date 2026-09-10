import { z } from 'zod';

export const pdfRectSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]);
export const pdfQuadSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]);
export const pdfSelectorSchema = z.object({
  kind: z.enum(['pdf-text', 'pdf-region']), representationId: z.string().min(1).max(128),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), extractionRevision: z.number().int().nonnegative(),
  exact: z.string().max(100_000).default(''),
  segments: z.array(z.object({page: z.number().int().positive(), quads: z.array(pdfQuadSchema).min(1).max(5000),
    startOffset: z.number().int().nonnegative().optional(), endOffset: z.number().int().nonnegative().optional(), exact: z.string().max(100_000).optional(),
  })).min(1).max(100),
}).superRefine((value, context) => {
  if (value.kind === 'pdf-region' && value.segments.length !== 1) context.addIssue({ code: 'custom', message: 'A region must be on one page' });
  if (value.kind === 'pdf-text') for (const segment of value.segments) {
    if (segment.startOffset === undefined || segment.endOffset === undefined || segment.endOffset <= segment.startOffset) context.addIssue({ code: 'custom', message: 'Text selections need a non-empty indexed range' });
  }
});
export type PdfSelector = z.infer<typeof pdfSelectorSchema>;
export type PdfRect = z.infer<typeof pdfRectSchema>;
export type PdfQuad = z.infer<typeof pdfQuadSchema>;
export const ocrLanguageSchema = z.enum(['eng', 'eng+kor']);
export type OcrLanguage = z.infer<typeof ocrLanguageSchema>;
export type PdfTextStatus = 'pending' | 'native' | 'ocr' | 'image-only' | 'failed';
export interface PdfPageItem {
  text: string; start: number; end: number; quad: PdfQuad;
  transform?: number[] | undefined; width?: number | undefined; height?: number | undefined; fontName?: string | undefined; dir?: string | undefined; hasEOL?: boolean | undefined; confidence?: number | undefined;
}
export interface PdfPage {
  page: number; sourcePage: number; label?: string; view: PdfRect; rotation: number;
  text: string; textStatus: PdfTextStatus; items: PdfPageItem[]; confidence?: number; error?: string;
  transcript?: string; readingOrder?: string[];
}
export interface DocumentRepresentation {
  id: string; kind: 'html' | 'pdf'; status: 'preparing' | 'indexing' | 'ready' | 'partial' | 'failed' | 'cancelled';
  extractionRevision: number; documentVersionId?: string; version?: number; sourceHash?: string; pageCount?: number; error?: string;
}
export interface PdfReadingProgress { page: number; offsetRatio: number; zoom?: number; rotation?: number; lastThreadId?: string | null }
export interface PdfManifest {
  representationId: string; sourceHash: string; pdfHash: string; url: string; extractionRevision: number;
  status: DocumentRepresentation['status']; pages: PdfPage[]; progress?: PdfReadingProgress; ocrLanguage: OcrLanguage;
}
export interface SourceCitation { id: string; label: string; selector: PdfSelector }
