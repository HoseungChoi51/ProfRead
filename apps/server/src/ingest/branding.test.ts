import { describe, expect, it } from 'vitest';
import { loadProfreadHtml } from './branding.js';
import { sanitizeDocument } from './sanitize.js';
import { applyDocumentEditOperations } from '../edits/index.js';

describe('saved HTML branding compatibility',()=>{
  it('retains old styles and markers while exposing current aliases',()=>{
    const source='<figure class="afterdraft-table-scroll custom" data-afterdraft-layout-width="full"><p data-afterdraft-source-ref="pdf:p001:title">Exact original text</p></figure>';
    const $=loadProfreadHtml(source),figure=$('figure');
    expect(figure.hasClass('afterdraft-table-scroll')).toBe(true);
    expect(figure.hasClass('profread-table-scroll')).toBe(true);
    expect(figure.attr('data-profread-layout-width')).toBe('full');
    expect(figure.attr('data-afterdraft-layout-width')).toBe('full');
    const current=source.replaceAll('afterdraft','profread');
    expect(sanitizeDocument(source,'article.html',()=>null).blocks.map(item=>item.id)).toEqual(sanitizeDocument(current,'article.html',()=>null).blocks.map(item=>item.id));
    expect(source).not.toContain('profread');
  });
  it('respects canonical values when both attribute generations exist',()=>{
    const $=loadProfreadHtml('<p data-afterdraft-layout-width="full" data-profread-layout-width="content">Text</p>');
    expect($('p').attr('data-profread-layout-width')).toBe('content');
  });
  it('does not resurrect removed legacy flags after a saved edit is reopened',()=>{
    const source='<figure data-block-id="figure" data-afterdraft-enlargeable=""><img src="figure.png" alt="Figure"></figure>';
    const edited=applyDocumentEditOperations(source,[{type:'set-object-layout',blockId:'figure',width:'auto',alignment:'center',folded:false,enlargeable:false}]);
    const reopened=loadProfreadHtml(edited.html);
    expect(reopened('figure').attr('data-profread-enlargeable')).toBeUndefined();
    expect(reopened('figure').attr('data-afterdraft-enlargeable')).toBeUndefined();
  });
});
