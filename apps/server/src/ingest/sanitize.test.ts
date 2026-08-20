import { describe,expect,it } from 'vitest';
import * as cheerio from 'cheerio';
import { BRIDGE,MOVE_READER_CSS,READER_CSS,canonicalTextNodePlan,canonicalizeBlockText,looseAcademicCaptionKind,normalizeAssetPath,sanitizeDocument,sanitizeStylesheet,sanitizeSvgAsset,textFragmentsForOffsets } from './sanitize.js';
describe('sanitization',()=>{
  it('rejects traversal and external resources',()=>{expect(normalizeAssetPath('', '../secret')).toBeNull();expect(normalizeAssetPath('article','https://evil.test/x')).toBeNull();expect(normalizeAssetPath('article','../img/a.png')).toBe('img/a.png');});
  it('removes active content and assigns blocks',()=>{const result=sanitizeDocument('<html><head><style>@import "https://evil";p{background:url(https://evil)}</style></head><body><script>alert(1)</script><form>x</form><p onclick="x()">Hello world</p><img src="img.png" onerror="x()"></body></html>','index.html',p=>`/asset/${p}`);expect(result.html).not.toContain('onclick');expect(result.html).not.toContain('alert(1)');expect(result.html).not.toContain('https://evil');expect(result.html).toContain('data-block-id');expect(result.canonicalText).toContain('Hello world');});
  it('keeps the authoritative entry title separate from the first section heading',()=>{const title='Research & Development <Review>',result=sanitizeDocument('<title>Wrong source title</title><p>Paper title</p><h1>Abstract</h1>','paper.html',()=>null,title);expect(result.title).toBe(title);expect(result.html).toContain('<title>Research &amp; Development &lt;Review&gt;</title>');expect(result.html).toContain('<h1 data-block-id=');expect(result.html).toContain('>Abstract</h1>')});
  it('preserves local stylesheets and rewrites nested CSS assets',()=>{const result=sanitizeDocument('<html><head><link rel="stylesheet" href="css/main.css"></head><body><p>Hello</p></body></html>','index.html',p=>`/asset/${p}`);expect(result.html).toContain('href="/asset/css/main.css"');const css=sanitizeStylesheet('@import "https://evil";.hero{background:url(../img/a.png)}','css/main.css',p=>`/asset/${p}`);expect(css).not.toContain('@import');expect(css).toContain('/asset/img/a.png')});
  it('preserves a safe video container as a caption target without remote playback',()=>{const result=sanitizeDocument('<video controls aria-label="Demonstration"><source src="https://evil.test/demo.mp4"></video>','index.html',p=>`/asset/${p}`);expect(result.html).toContain('<video controls="" aria-label="Demonstration"');expect(result.html).not.toContain('evil.test');expect(result.blocks).toEqual(expect.arrayContaining([expect.objectContaining({type:'video',text:'Demonstration'})]))});
  it('keeps validated embedded raster images and only YouTube embeds',()=>{const png='data:image/png;base64,iVBORw0KGgo=',result=sanitizeDocument(`<img src="${png}"><img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="><iframe src="https://www.youtube.com/embed/1kXnsvYfaF4?start=1302"></iframe><iframe src="https://evil.test/embed/1kXnsvYfaF4"></iframe>`,'index.html',()=>null);expect(result.html).toContain(png);expect(result.html).not.toContain('src="data:image/svg+xml');expect(result.html).toContain('https://www.youtube-nocookie.com/embed/1kXnsvYfaF4?start=1302');expect(result.html).not.toContain('evil.test')});
  it('sanitizes standalone SVG assets before authenticated serving',()=>{const result=sanitizeSvgAsset('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><foreignObject><iframe src="https://evil.test"></iframe></foreignObject><defs><symbol id="dot"><circle cx="2" cy="2" r="1"/></symbol></defs><use href="#dot"/><use href="https://evil.test/icon.svg#dot"/><path d="M0 0L1 1" onclick="bad()"/></svg>');expect(result).toContain('<svg');expect(result).toContain('href="#dot"');expect(result).not.toContain('alert(1)');expect(result).not.toContain('foreignObject');expect(result).not.toContain('evil.test');expect(result).not.toContain('onclick')});
  it('preserves normalized inline SVG geometry and safe local marker references',()=>{const result=sanitizeDocument(`<style>.arrow{marker-end:url(#arrow)}.external{marker-end:url(https://evil.test/arrow.svg#x)}</style><figure><svg viewbox=" 0, 0, 1040, 300 " role="img"><defs><marker id="arrow" markerwidth="10" markerheight="10" refx="8" refy="3" orient="auto" markerunits="strokeWidth"><path d="M0 0L9 3L0 6z"/></marker></defs><path class="arrow" d="M0 0H100" style="marker-end:url('#arrow');fill:url(https://evil.test/fill.svg#x)"/><path class="external" d="M0 1H100" marker-end="url(//evil.test/arrow.svg#x)"/></svg><figcaption>Figure 1. Safe marker.</figcaption></figure><svg viewBox="0 0 NaN 20"></svg>`,'paper.html',()=>null),$=cheerio.load(result.html),svg=$('svg').first(),marker=svg.find('marker'),path=svg.find('path.arrow');expect(svg.attr('viewBox')).toBe('0 0 1040 300');expect(marker).toHaveLength(1);expect(marker.attr()).toMatchObject({id:'arrow',markerWidth:'10',markerHeight:'10',refX:'8',refY:'3',orient:'auto',markerUnits:'strokeWidth'});expect(path.attr('style')).toContain('marker-end:url("#arrow")');expect(path.attr('style')).toContain('fill:url("")');expect(result.html).toContain('.arrow{marker-end:url("#arrow")}');expect(result.html).not.toContain('evil.test');expect($('svg').eq(1).attr('viewBox')).toBeUndefined()});
  it('keeps safe standalone SVG viewBox and marker definitions while rejecting external references',()=>{const result=sanitizeSvgAsset(`<svg viewBox="-0 0 1080 360"><defs><marker id="tip" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0 0L8 3L0 6z"/></marker></defs><path d="M0 3H90" style="marker-end:url(#tip);stroke:url(https://evil.test/paint.svg#x)"/><use href="#tip"/><use href="data:image/svg+xml,bad"/></svg>`);expect(result).not.toBeNull();const $=cheerio.load(result!,{xmlMode:true}),svg=$('svg'),marker=$('marker');expect(svg.attr('viewBox')).toBe('0 0 1080 360');expect(marker.attr()).toMatchObject({markerWidth:'8',markerHeight:'6',refX:'7',refY:'3',orient:'auto-start-reverse',markerUnits:'userSpaceOnUse'});expect($('path').last().attr('style')).toBe('marker-end:url("#tip");stroke:url("")');expect($('use').first().attr('href')).toBe('#tip');expect($('use').last().attr('href')).toBeUndefined();expect(result).not.toContain('evil.test');expect(result).not.toContain('data:image')});
  it('preserves native MathML, semantic source identity, and safe scholarly links',()=>{const result=sanitizeDocument(`<p>Inline <math alttext="x squared"><semantics><msup><mi>x</mi><mn>2</mn></msup><annotation encoding="application/x-tex">secret-source</annotation></semantics></math>.</p><math display="block" alttext="integral"><mrow><mo>∫</mo><mi>f</mi></mrow><annotation encoding="application/x-tex">\\int f</annotation></math><p data-afterdraft-source-ref="section:intro">Text <a href="#references" target="_blank">[1]</a> <a href="https://doi.org/10.1/example">DOI</a> <a href="javascript:alert(1)">bad</a></p><h2 id="references">References</h2>`,'paper.html',()=>null);expect(result.html).toContain('<math');expect(result.html).toContain('<msup>');expect(result.html).toContain('alttext="integral"');expect(result.html).toContain('href="#references"');expect(result.html).not.toMatch(/href="#references"[^>]*target=/);expect(result.html).toContain('href="https://doi.org/10.1/example"');expect(result.html).toContain('<a href="#" data-original-href="javascript:alert(1)"');expect(result.canonicalText).toContain('Inline x2.');expect(result.canonicalText).not.toContain('secret-source');expect(result.canonicalText).toContain('integral');const again=sanitizeDocument(`<p data-afterdraft-source-ref="section:intro">Changed presentation</p>`,'paper.html',()=>null);expect(again.blocks[0]?.id).toBe(result.blocks.find(block=>block.text.includes('Text'))?.id)});
  it('keeps MathML source annotations out of repeated-word coordinates',()=>{const result=sanitizeDocument('<p>same <math><mtext>x</mtext><annotation encoding="application/x-tex">same hidden same</annotation></math> same</p>','math.html',()=>null),block=result.blocks[0]!;expect(block.text).toBe('same x same');expect(block.text.lastIndexOf('same')).toBe(7);expect(block.text).not.toContain('hidden')});
  it('uses converter and arXiv element ids as stable source identity',()=>{const first=sanitizeDocument('<h2 id="sec-method">Methods</h2>','paper.html',()=>null),revised=sanitizeDocument('<p>New material</p><h2 id="sec-method">Methods revised</h2>','paper.html',()=>null);expect(first.blocks[0]?.id).toBe(revised.blocks[1]?.id)});
  it('wraps wide tables in a keyboard-scrollable browsing container',()=>{const result=sanitizeDocument('<table><caption>Results</caption><tr><th>A</th><td>1</td></tr></table>','paper.html',()=>null);expect(result.html).toContain('class="afterdraft-table-scroll"');expect(result.html).toContain('aria-label="Scrollable table"');expect(result.html).toContain('.afterdraft-table-scroll>table');expect(result.blocks).toEqual(expect.arrayContaining([expect.objectContaining({type:'table',text:'ResultsA1'})]))});
  it('recognizes only numbered academic loose captions',()=>{expect(looseAcademicCaptionKind('Figure 1. Response')).toBe('figure');expect(looseAcademicCaptionKind('Fig. S2. Supplement')).toBe('figure');expect(looseAcademicCaptionKind('Table IV: Results')).toBe('table');expect(looseAcademicCaptionKind('Figure overview without a number')).toBeNull();expect(looseAcademicCaptionKind('Table of contents')).toBeNull()});
it('ships a syntactically valid sandbox bridge with direct academic editing and safe navigation messages',()=>{expect(()=>new Function(BRIDGE)).not.toThrow();expect(BRIDGE).toContain('edit-context');expect(BRIDGE).toContain('finish-editing');expect(BRIDGE).toContain("type:'resize-image'");expect(BRIDGE).toContain('startEditing(text.dataset.blockId)');expect(BRIDGE).toContain("data.operation.type==='set-alt-text'");expect(BRIDGE).toContain("data.operation.type==='set-heading-level'");expect(BRIDGE).toContain("data.operation.type==='set-object-layout'");expect(BRIDGE).toContain("data.operation.type==='move-object'");expect(BRIDGE).toContain("send('open-external-link',{href})");expect(BRIDGE).toContain("if(href.startsWith('#'))return");expect(BRIDGE).toContain("send('move-destination'");expect(BRIDGE).toContain("send('move-placement'");expect(BRIDGE).toContain('looseCaptionFor');expect(BRIDGE).toContain('moveCompanion');expect(BRIDGE).toContain('visualMoveBoundary');expect(MOVE_READER_CSS).toContain('.afterdraft-move-slot');expect(MOVE_READER_CSS).toContain('content:"Place here"')});
it('preserves structured caption bodies in the edit preview',()=>{
  expect(BRIDGE).toContain("structured:Boolean(bodyNode.querySelector('*'))");
  expect(BRIDGE).toContain('operation.caption!==current.caption');
  expect(BRIDGE).toContain('preserveBody?current.bodyHtml:undefined');
  expect(BRIDGE).toContain("send('edit-preview-error'");
  expect(BRIDGE).toContain('&&!richCaption');
});
it('refreshes and reveals the exact stored selection range, including folded sections',()=>{expect(BRIDGE).toContain('selection-geometry');expect(BRIDGE).toContain("data.type==='refresh-selection'");expect(BRIDGE).toContain("data.type==='reveal-selection'");expect(BRIDGE).toContain('rangeFor(el,data.startOffset,data.endOffset)');expect(BRIDGE).toContain("closest('details:not([open])')");expect(BRIDGE).toContain('folded.open=true');expect(BRIDGE).toContain('new ResizeObserver')});
it('creates bridge selection contexts without splitting UTF-16 surrogate pairs',()=>{
  expect(BRIDGE).toContain('utf16ContextWindow(full,position.start,position.end)');
  expect(BRIDGE).toContain('prefix:context.prefix,suffix:context.suffix');
  expect(()=>new Function(BRIDGE)).not.toThrow();
});
it('debounces native selection changes without duplicating completed ranges',()=>{
  expect(BRIDGE).toContain('selectionTimer=setTimeout');
  expect(BRIDGE).toContain('},280)');
  expect(BRIDGE).toContain("addEventListener('pointerdown',()=>{pointerSelecting=true;clearSelectionTimer()})");
  expect(BRIDGE).toContain("addEventListener('pointerup',finishPointerSelection)");
  expect(BRIDGE).toContain("addEventListener('mouseup',finishPointerSelection)");
  expect(BRIDGE).toContain("if(pointerSelecting||shiftSelecting)return");
  expect(BRIDGE).toContain("if(e.key==='Shift'){shiftSelecting=true;clearSelectionTimer()}");
  expect(BRIDGE).toContain("if(e.key==='Shift'){shiftSelecting=false;selectImmediately()}");
  expect(BRIDGE).not.toContain("e.shiftKey||e.key==='Shift'");
  expect(BRIDGE).toContain('const selectImmediately=()=>{clearSelectionTimer();selected()}');
  expect(BRIDGE).toContain("storedSelection?.kind==='text'&&storedSelection.blockId===blockId&&storedSelection.startOffset===position.start&&storedSelection.endOffset===position.end");
  expect(BRIDGE).toContain("data.type==='clear-stored-selection')clearStoredSelection()");
  expect(BRIDGE).not.toContain('selectionFrame');
});
it('plans exact cross-node fragments, including the second repeated inline phrase',()=>{
  expect(textFragmentsForOffsets([6,4,6],3,13)).toEqual([
    {index:0,start:3,end:6},
    {index:1,start:0,end:4},
    {index:2,start:0,end:3},
  ]);
  expect(textFragmentsForOffsets([6,4,7,6,4,7],17,27)).toEqual([
    {index:3,start:0,end:6},
    {index:4,start:0,end:4},
  ]);
  expect(textFragmentsForOffsets([5,5],4,11)).toEqual([]);
  expect(textFragmentsForOffsets([5,-1,5],1,3)).toEqual([]);
});
it('maps normalized whitespace and cross-inline-node offsets deterministically',()=>{
  expect(canonicalizeBlockText('  first\n\t same   word  ')).toBe('first same word');
  const values=['  first ','same',' \t','word',' between ','same','\n','word  '],plan=canonicalTextNodePlan(values),exact='same word',start=plan.text.lastIndexOf(exact),rawStart=values.slice(0,5).join('').length,rawEnd=rawStart+values.slice(5,8).join('').length-2;
  expect(plan.text).toBe('first same word between same word');
  expect(start).toBeGreaterThan(plan.text.indexOf(exact));
  expect(plan.offsetForRaw(rawStart)).toBe(start);
  expect(plan.offsetForRaw(rawEnd)).toBe(start+exact.length);
  expect(plan.fragments(start,start+exact.length)).toEqual([{index:5,start:0,end:4},{index:6,start:0,end:1},{index:7,start:0,end:4}]);
});
it('renders and refreshes accessible semantic anchor marks',()=>{
  expect(READER_CSS).toContain('.afterdraft-highlight-important');
  expect(READER_CSS).toContain('.afterdraft-highlight-question');
  expect(READER_CSS).toContain('text-decoration-style:wavy');
  expect(READER_CSS).toContain('.afterdraft-highlight-comment');
  expect(READER_CSS).toContain('text-decoration-style:dotted');
  expect(READER_CSS).toContain('.afterdraft-definition');
  expect(BRIDGE).toContain("['important','question','comment'].includes(a.kind)");
  expect(BRIDGE).toContain('describeGroup(existing,a)');
  expect(BRIDGE).toContain('a.localStartOffset??a.local_start_offset');
  expect(BRIDGE).toContain('index.text.slice(storedStart,storedEnd)===a.exact');
  expect(BRIDGE).toContain("index.text.slice(Math.max(0,storedStart-prefix.length),storedStart)===prefix");
  expect(BRIDGE).toContain('index.text.slice(storedEnd,storedEnd+suffix.length)===suffix');
  expect(BRIDGE).toContain("a.status&&a.status!=='attached'");
  expect(BRIDGE).toContain("anchors.filter(anchor=>!anchor.status||anchor.status==='attached')");
  expect(BRIDGE).toContain("closest('annotation,annotation-xml')");
  expect(BRIDGE).toContain('applyAnchors(data.anchors)');
  expect(BRIDGE).toContain('span.dataset.annotationText=annotation');
  expect(BRIDGE).toContain("'. Annotation: '+annotation");
  expect(BRIDGE).toContain('span.title=tooltip');
  expect(BRIDGE).not.toContain("if(editMode)return");
});
it('reconciles visible thread previews without changing anchor text offsets',()=>{
  expect(READER_CSS).toContain('content:attr(data-preview)');
  expect(READER_CSS).toContain('-webkit-line-clamp:2');
  expect(READER_CSS).toContain('.afterdraft-discussion[data-preview]::after');
  expect(READER_CSS).toContain('.afterdraft-definition[data-preview]::after');
  expect(READER_CSS).toContain('.afterdraft-discussion:focus-visible');
  expect(BRIDGE).toContain('span.dataset.preview=preview');
  expect(BRIDGE).toContain('span.dataset.previewSource=a.previewSource');
  expect(BRIDGE).toContain('delete span.dataset.preview;delete span.dataset.previewSource');
  expect(BRIDGE).toContain("fullPreview&&fullPreview!==annotation?'. Preview: '+fullPreview");
  expect(BRIDGE).toContain("join('').replace(/\\s+/g,' ').trim()!==a.exact");
  expect(BRIDGE).toContain('if(existing.length){describeGroup(existing,a);return}');
  expect(BRIDGE).toContain('clearMarks()');
});
it('wraps multi-node selections as one logical accessible anchor',()=>{
  expect(BRIDGE).toContain('function textFragmentsForOffsets');
  expect(BRIDGE).toContain('const wrapFragments=');
  expect(BRIDGE).toContain('range.surroundContents(part)');
  expect(BRIDGE).toContain('parts.unshift(part)');
  expect(BRIDGE).toContain("part.dataset.anchorPart=String(index+1)+'/'+parts.length");
  expect(BRIDGE).toContain('describeMark(part,a,index===0,index===parts.length-1)');
  expect(BRIDGE).toContain("span.setAttribute('aria-hidden','true')");
  expect(BRIDGE).toContain("span.setAttribute('role','button')");
  expect(BRIDGE).toContain('const unwrapMarks=');
  expect(BRIDGE).toContain('parent.normalize()');
  expect(BRIDGE).toContain('start=hasExactCoordinates?storedStart:null');
  expect(BRIDGE).not.toContain('contextualAnchorStart');
  expect(BRIDGE).toContain('part.dataset.anchorStart=String(start)');
  expect(BRIDGE).toContain('part.dataset.anchorEnd=String(end)');
  expect(BRIDGE).toContain("part.dataset.anchorStart!==String(start)");
  expect(BRIDGE).toContain('wrapFragments(el,start,end,a)');
  expect(BRIDGE).not.toContain('fallbackStart');
});
it('keeps raw edit coordinates separate from canonical anchor coordinates',()=>{
  expect(BRIDGE).toContain('const rawOffsets=');
  expect(BRIDGE).toContain('const rawRangeFor=');
  expect(BRIDGE).toContain('const value=rawOffsets(text,selection.getRangeAt(0))');
  expect(BRIDGE).toContain('range=el&&rawRangeFor(el,operation.startOffset,operation.endOffset)');
});
it('keeps drag selections actionable while edit mode retains single-click editing',()=>{
  expect(BRIDGE).not.toContain('const selected=()=>{if(editMode)return');
  expect(BRIDGE).toContain('hasDraggedSelection');
  expect(BRIDGE.indexOf('if(hasDraggedSelection)')).toBeLessThan(BRIDGE.indexOf("clearStoredSelection();send('background-click')"));
  expect(BRIDGE).toContain('startEditing(text.dataset.blockId)');
  expect(BRIDGE).toContain("addEventListener('selectionchange'");
  expect(BRIDGE).toContain('suppressSelectionUntil');
  expect(BRIDGE).toContain("e.key==='Enter'||e.key===' '");
});
});
