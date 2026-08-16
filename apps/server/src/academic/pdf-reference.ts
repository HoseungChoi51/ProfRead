import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractRenderBundle, type AcademicManifest, type ExtractedBundleFile } from './bundle.js';
import { renderPdf } from './worker-client.js';

export type PdfReferenceResult = {
  files: ExtractedBundleFile[];
  warnings: AcademicManifest['warnings'];
};

/**
 * Rasterize a trusted, already signature-checked local PDF through the
 * credential-free worker. Only reference page images leave this helper; the
 * uploaded PDF and the renderer manifest never become publishable assets.
 */
export async function pdfReferenceEvidence(
  sourcePath:string,
  directory:string,
  signal?:AbortSignal,
):Promise<PdfReferenceResult>{
  const bytes=await readFile(sourcePath),sourceHash=createHash('sha256').update(bytes).digest('hex');
  const archive=await renderPdf(sourcePath,60,signal);
  const bundle=await extractRenderBundle(archive,join(directory,'pdf-reference'),sourceHash);
  return{
    files:bundle.files.filter(file=>/^reference\/page-\d+\.png$/i.test(file.path)),
    warnings:bundle.manifest.warnings??[],
  };
}
