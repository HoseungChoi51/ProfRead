import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { academicOutline, visibleAcademicText, writeSelfContainedPreview } from './evidence.js';

describe('academic review evidence', () => {
  it('embeds authenticated assets without exposing hidden annotations as visible text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afterdraft-evidence-'));
    const image = join(root, 'image.png'), css = join(root, 'paper.css'), preview = join(root, 'preview.html'), output = join(root, 'render.html');
    await writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await writeFile(css, '.hero{background:url("image.png")}');
    await writeFile(preview, '<link rel="stylesheet" href="/api/import-jobs/job-1/assets/css"><p data-block-id="p1">Visible <math><mi>x</mi><annotation>hidden-source</annotation></math></p><img data-block-id="i1" src="/api/import-jobs/job-1/assets/image" alt="Plot">');
    const staged: any = { assets: [
      { id: 'image', sourcePath: 'image.png', mimeType: 'image/png', storagePath: image },
      { id: 'css', sourcePath: 'paper.css', mimeType: 'text/css', storagePath: css },
    ] };
    await writeSelfContainedPreview('job-1', preview, staged, output);
    const html = await readFile(output, 'utf8');
    expect(html).toContain('data:text/css;base64,');
    expect(html).toContain('data:image/png;base64,');
    expect(html).not.toContain('/api/import-jobs/');
    const outline = academicOutline(html);
    expect(visibleAcademicText(outline)).toContain('[p1] <p> Visible x');
    expect(visibleAcademicText(outline)).not.toContain('hidden-source');
  });

  it('rejects oversized staged assets before reading them into memory', async () => {
    const directory=await mkdtemp(join(tmpdir(),'afterdraft-evidence-limit-')),previewPath=join(directory,'preview.html');
    await writeFile(previewPath,'<html><body><img src="/api/import-jobs/job-limit/assets/large"></body></html>');
    await expect(writeSelfContainedPreview('job-limit',previewPath,{
      entryPath:'document.html',bundleDirectory:directory,derivativeHash:'a'.repeat(64),manifest:{},
      assets:[{id:'large',sourcePath:'large.png',mimeType:'image/png',storagePath:join(directory,'does-not-exist.png'),bytes:60*1024*1024,sha256:'b'.repeat(64)}],
    },join(directory,'output.html'))).rejects.toThrow(/exceeds 64 MB/);
  });
});
