import {strToU8,zipSync} from 'fflate';
import {describe,expect,it} from 'vitest';
import {matchPublishedArchiveEntry,readPublishedArchiveAssets} from './published-archive.js';

const jpeg=Buffer.from([0xff,0xd8,0xff,0xd9]);

describe('published repository archives',()=>{
  it('inventories the complete archive but reads only explicitly referenced assets',async()=>{
    const archive=Buffer.from(zipSync({'paper/fig-1.jpg':jpeg,'supplement.pdf':strToU8('%PDF-1.7 supplement'),'unreferenced.jpg':jpeg})),result=await readPublishedArchiveAssets(archive,['fig-1.jpg']);
    expect(result.entries.map(entry=>entry.path)).toEqual(['paper/fig-1.jpg']);
    expect(matchPublishedArchiveEntry('fig-1.jpg',result.entries)?.bytes).toEqual(jpeg);
  });

  it('does not guess when an archive contains ambiguous basenames',async()=>{
    const archive=Buffer.from(zipSync({'first/fig.jpg':jpeg,'second/fig.jpg':jpeg})),result=await readPublishedArchiveAssets(archive,['fig.jpg']);
    expect(result.entries).toHaveLength(2);expect(matchPublishedArchiveEntry('fig.jpg',result.entries)).toBeNull();
  });

  it('rejects unsafe references and unsafe archive paths',async()=>{
    const safe=Buffer.from(zipSync({'fig.jpg':jpeg})),result=await readPublishedArchiveAssets(safe,['../fig.jpg']);expect(result.unsafeReferences).toEqual(['../fig.jpg']);expect(result.entries).toHaveLength(0);
    const unsafe=Buffer.from(zipSync({'../fig.jpg':jpeg}));await expect(readPublishedArchiveAssets(unsafe,['fig.jpg'])).rejects.toThrow(/(?:unsafe repository archive path|invalid relative path)/i);
  });

  it('enforces expansion limits even for unselected entries',async()=>{
    const archive=Buffer.from(zipSync({'fig.jpg':jpeg,'large.bin':new Uint8Array(4096)}));await expect(readPublishedArchiveAssets(archive,['fig.jpg'],{maxExpandedBytes:128})).rejects.toThrow(/expansion (?:limit|ratio)/);
  });
});
