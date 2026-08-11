import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db, now, row } from '../db/index.js';
import { importSource } from '../ingest/index.js';
import { buildContext, formatReaderSignal } from './context.js';

describe('reader signals in model context', () => {
  it('renders the three signal kinds with explicit semantic labels', () => {
    expect(formatReaderSignal({ id: 'i', kind: 'important', exactQuote: '  Key   claim ', note: null })).toBe('[IMPORTANT] "Key claim"');
    expect(formatReaderSignal({ id: 'c', kind: 'comment', exactQuote: 'Claim', note: '  add   nuance ' })).toBe('[READER COMMENT] "Claim" — add nuance');
    expect(formatReaderSignal({ id: 'q', kind: 'question', exactQuote: 'Claim', note: 'Evidence?' })).toBe('[OPEN QUESTION] "Claim" — Evidence?');
  });

  it('includes typed signals and their text in the context token estimate', async () => {
    const imported=await importSource({buffer:Buffer.from('<title>Signals</title><p>A consequential claim appears here.</p>'),filename:'signals.html',mimeType:'text/html'});
    if(!imported.versionId)throw new Error('Import did not create a version');
    const versionId=imported.versionId,before=buildContext(versionId,'quick'),block=row<{id:string;start_offset:number;end_offset:number;text_content:string}>('SELECT id,start_offset,end_offset,text_content FROM blocks WHERE document_version_id=? AND block_type=\'text\' ORDER BY ordinal LIMIT 1',versionId)!;
    const anchorId=randomUUID(),signalId=randomUUID(),time=now();
    db.prepare('INSERT INTO anchors(id,document_version_id,block_id,exact_quote,prefix_text,suffix_text,start_offset,end_offset,block_type,created_at)VALUES(?,?,?,?,?,?,?,?,?,?)').run(anchorId,versionId,block.id,block.text_content,'','',block.start_offset,block.end_offset,'text',time);
    db.prepare('INSERT INTO highlights(id,anchor_id,checked,color,kind,note,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?)').run(signalId,anchorId,1,'yellow','important','Reader priority',time,time);
    const after=buildContext(versionId,'quick');
    expect(after.readerSignals).toEqual([{id:signalId,kind:'important',exactQuote:block.text_content,note:'Reader priority'}]);
    expect(after.curatedNotes[0]).toContain('[IMPORTANT]');
    expect(after.tokenEstimate).toBeGreaterThan(before.tokenEstimate);
  });
});
