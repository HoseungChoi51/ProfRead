import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import sanitizeHtml from 'sanitize-html';

export interface SanitizedDocument {
  html: string; title: string; canonicalText: string;
  blocks: Array<{ id: string; ordinal: number; type: string; text: string; visual?: string; start: number; end: number }>;
}

const blockSelector = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,table,img,svg,figure';
const allowedTags = sanitizeHtml.defaults.allowedTags.concat(['html','head','body','link','main','article','section','figure','figcaption','picture','source','svg','path','g','circle','rect','line','polyline','polygon','ellipse','text','defs','use','symbol','table','thead','tbody','tfoot','tr','th','td','colgroup','col','details','summary']);
const allowedAttributes: sanitizeHtml.IOptions['allowedAttributes'] = {
  '*': ['id','class','title','aria-label','aria-describedby','role','data-*'],
  a: ['href','name','target','rel'], img: ['src','alt','width','height','srcset'], source: ['src','srcset','type','media'],
  link: ['href','rel','media'],
  svg: ['viewBox','width','height','xmlns','fill','stroke','aria-label','role'],
  path: ['d','fill','stroke','stroke-width'], g: ['transform','fill','stroke'], circle: ['cx','cy','r','fill','stroke'],
  rect: ['x','y','rx','ry','width','height','fill','stroke'], line: ['x1','y1','x2','y2','stroke'],
  polyline: ['points','fill','stroke'], polygon: ['points','fill','stroke'], ellipse: ['cx','cy','rx','ry','fill','stroke'],
  text: ['x','y','dx','dy','text-anchor','font-size','fill'], use: ['href'], table: ['summary'], th: ['scope','colspan','rowspan'], td: ['colspan','rowspan'],
};

const remoteOrDangerous = /^(?:https?:|data:|javascript:|vbscript:|file:|\/\/)/i;
export function normalizeAssetPath(base: string, value: string): string | null {
  const clean = value.split(/[?#]/, 1)[0]?.replaceAll('\\', '/') ?? '';
  if (!clean || remoteOrDangerous.test(clean) || clean.startsWith('/')) return null;
  const segments = `${base}/${clean}`.split('/'); const result: string[] = [];
  for (const segment of segments) { if (!segment || segment === '.') continue; if (segment === '..') { if (!result.length) return null; result.pop(); } else result.push(segment); }
  return result.join('/');
}

function safeCss(css: string, rewrite: (path: string) => string | null): string {
  return css
    .replace(/@import[\s\S]*?(?:;|$)/gi, '')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_all, _q, url: string) => { const safe = rewrite(url); return safe ? `url("${safe}")` : 'url("")'; });
}
export function sanitizeStylesheet(css:string,sourcePath:string,assetUrl:(path:string)=>string|null):string{const base=sourcePath.includes('/')?sourcePath.slice(0,sourcePath.lastIndexOf('/')):'';return safeCss(css,value=>{const path=normalizeAssetPath(base,value);return path?assetUrl(path):null})}

export function sanitizeDocument(source: string, entryPath: string, assetUrl: (path: string) => string | null): SanitizedDocument {
  const entryDir = entryPath.includes('/') ? entryPath.slice(0, entryPath.lastIndexOf('/')) : '';
  const $source = cheerio.load(source),sourceTitle=$source('title').first().text().replace(/\s+/g,' ').trim();
  const rewrite = (value: string): string | null => { const path = normalizeAssetPath(entryDir, value); return path ? assetUrl(path) : null; };
  let cleaned = sanitizeHtml(source, {
    allowedTags, allowedAttributes, allowedSchemes: [], allowProtocolRelative: false,
    disallowedTagsMode: 'discard', nonTextTags: ['script','style','textarea','xmp','iframe','noembed','noframes','plaintext','form','object','embed'],
    transformTags: {
      a: (_tag, attrs) => ({ tagName: 'a', attribs: { ...attrs, href: '#', 'data-original-href': attrs.href ?? '', rel: 'noopener noreferrer' } }),
      img: (_tag, attrs) => ({ tagName: 'img', attribs: { ...attrs, src: rewrite(attrs.src ?? '') ?? '', srcset: '' } }),
      source: (_tag, attrs) => ({ tagName: 'source', attribs: { ...attrs, src: rewrite(attrs.src ?? '') ?? '', srcset: '' } }),
      link: (_tag,attrs)=>({tagName:'link',attribs:{rel:attrs.rel?.toLowerCase()==='stylesheet'?'stylesheet':'',href:attrs.rel?.toLowerCase()==='stylesheet'?(rewrite(attrs.href??'')??''):'',...(attrs.media?{media:attrs.media}:{})}}),
    },
    exclusiveFilter: frame => ['iframe','form','object','embed'].includes(frame.tag),
  });
  const styles = $source('style').map((_i, el) => safeCss($source(el).html() ?? '', rewrite)).get().join('\n');
  const $ = cheerio.load(cleaned); $('*').each((_i, el) => {
    const node = $(el); for (const name of Object.keys(node.attr() ?? {})) if (/^on/i.test(name)) node.removeAttr(name);
    const inline = node.attr('style'); if (inline) node.attr('style', safeCss(inline, rewrite));
  });
  let offset = 0; const blocks: SanitizedDocument['blocks'] = [];const occurrences=new Map<string,number>();
  $(blockSelector).each((ordinal, el) => {
    const node = $(el); if (node.parents(blockSelector).length && !['img','svg'].includes(el.tagName)) return;
    const type = el.tagName === 'img' ? 'image' : el.tagName === 'svg' ? 'svg' : el.tagName === 'table' ? 'table' : el.tagName === 'figure' ? 'diagram' : 'text';
    const text = node.text().replace(/\s+/g, ' ').trim() || node.attr('alt') || node.attr('aria-label') || '';
    const signature=`${el.tagName}\0${text}`,occurrence=occurrences.get(signature)??0;occurrences.set(signature,occurrence+1);const stable = createHash('sha256').update(`${signature}\0${occurrence}`).digest('hex').slice(0, 20);
    const id = `block-${stable}`; node.attr('data-block-id', id); node.attr('tabindex', type === 'text' ? '-1' : '0');
    const visual=type==='image'?node.attr('src'):type==='svg'?$.html(el):undefined;
    blocks.push({ id, ordinal: blocks.length, type, text, ...(visual?{visual}:{}), start: offset, end: offset + text.length }); offset += text.length + 2;
  });
  const canonicalText = blocks.map(block => block.text).filter(Boolean).join('\n\n');
  const title = sourceTitle || $('h1').first().text().trim() || entryPath.split('/').pop()?.replace(/\.html?$/i, '') || 'Untitled';
  cleaned = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${$('head link[rel="stylesheet"][href]').toString()}<style>${styles}\n${READER_CSS}</style></head><body>${$('body').html() ?? $.root().html()}<script nonce="__CO_READER_NONCE__">${BRIDGE}</script></body></html>`;
  return { html: cleaned, title, canonicalText, blocks };
}

const READER_CSS = `:root{color-scheme:light dark}html{overflow-x:hidden}body{box-sizing:border-box;width:min(calc(100% - clamp(2rem,6vw,6rem)),1200px);max-width:none;margin:clamp(1.5rem,4vw,3rem) auto;padding:0;font:18px/1.65 ui-serif,Georgia,serif}body *{box-sizing:border-box}img,svg,table{max-width:100%;height:auto}pre,table{overflow:auto}[data-block-id]{scroll-margin:20vh}.co-reader-highlight{background:#ffe58a}.co-reader-discussion{background:#dbe8dc;text-decoration:underline dotted #526b58;cursor:pointer}.co-reader-definition{background:#e5ddf3;text-decoration:underline dotted #6b5684;cursor:pointer}`;
const BRIDGE = `(()=>{const send=(type,data)=>parent.postMessage({source:'co-reader',type,...data},'*');const layout=()=>send('layout',{ratio:scrollY/Math.max(1,document.documentElement.scrollHeight-innerHeight),blocks:[...document.querySelectorAll('[data-block-id]')].map(el=>({blockId:el.dataset.blockId,top:el.getBoundingClientRect().top,height:el.getBoundingClientRect().height}))});const mark=a=>{const el=document.querySelector('[data-block-id="'+CSS.escape(a.blockId)+'"]');if(!el||!a.exact||el.querySelector('[data-anchor-id="'+CSS.escape(a.id)+'"]'))return;const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){const index=node.data.indexOf(a.exact);if(index>=0){const range=document.createRange();range.setStart(node,index);range.setEnd(node,index+a.exact.length);const span=document.createElement('mark');span.dataset.anchorId=a.id;span.className=a.checked?'co-reader-highlight':a.action==='define'?'co-reader-definition':'co-reader-discussion';span.tabIndex=0;span.setAttribute('aria-label',(a.checked?'Checked highlight: ':a.action==='define'?'Definition: ':'Discussion: ')+a.exact);range.surroundContents(span);break}}};const capture=el=>{if(!['TABLE','FIGURE'].includes(el.tagName))return;const rect=el.getBoundingClientRect(),width=Math.min(1800,Math.max(1,Math.ceil(rect.width))),height=Math.min(1800,Math.max(1,Math.ceil(rect.height))),markup=new XMLSerializer().serializeToString(el),svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">'+markup+'</div></foreignObject></svg>',image=new Image();image.onload=()=>{try{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,width,height);context.drawImage(image,0,0);send('visual-capture',{blockId:el.dataset.blockId,mimeType:'image/png',data:canvas.toDataURL('image/png').split(',')[1]})}catch{}};image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg)};const selected=()=>{const s=getSelection();if(!s||s.isCollapsed)return;const r=s.getRangeAt(0),origin=r.commonAncestorContainer.nodeType===1?r.commonAncestorContainer:r.commonAncestorContainer.parentElement;if(origin?.closest('[data-anchor-id]'))return;const el=origin?.closest('[data-block-id]');if(!el)return;const exact=s.toString(),full=el.textContent||'',local=Math.max(0,full.indexOf(exact));send('selection',{blockId:el.dataset.blockId,exact,prefix:full.slice(Math.max(0,local-32),local),suffix:full.slice(local+exact.length,local+exact.length+32),startOffset:local,endOffset:local+exact.length,rect:r.getBoundingClientRect().toJSON()})};let frame;document.addEventListener('scroll',()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(layout)},{passive:true});addEventListener('resize',layout);document.addEventListener('mouseup',selected);document.addEventListener('keyup',e=>{if(e.shiftKey)selected()});document.addEventListener('click',e=>{const el=e.target.closest('[data-block-id]');if(el&&['IMG','SVG','TABLE','FIGURE'].includes(el.tagName)){send('block-selection',{blockId:el.dataset.blockId,blockType:el.tagName.toLowerCase(),rect:el.getBoundingClientRect().toJSON()});capture(el)}const anchor=e.target.closest('[data-anchor-id]');if(anchor)send('anchor-click',{anchorId:anchor.dataset.anchorId})});addEventListener('message',e=>{if(e.data?.type==='scroll-to-block'){const target=document.querySelector('[data-block-id="'+CSS.escape(e.data.blockId)+'"]');target?.scrollIntoView({behavior:'smooth',block:'center'});target?.focus({preventScroll:true})}if(e.data?.type==='restore-progress')scrollTo(0,Math.max(0,e.data.ratio)*Math.max(0,document.documentElement.scrollHeight-innerHeight));if(e.data?.type==='apply-anchors')e.data.anchors.forEach(mark)});send('ready',{});setTimeout(layout,50)})();`;
