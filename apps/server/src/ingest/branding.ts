import * as cheerio from 'cheerio';

/** Add current aliases in a parsed derivative, never rewrite immutable source bytes. */
export function loadProfreadHtml(...args: Parameters<typeof cheerio.load>): ReturnType<typeof cheerio.load> {
  const $ = cheerio.load(...args);
  $('*').each((_index, element) => {
    if (!('attribs' in element)) return;
    const node = $(element);
    for (const [name, value] of Object.entries(element.attribs)) {
      if (name.startsWith('data-afterdraft-')) {
        const alias = name.replace('data-afterdraft-', 'data-profread-');
        if (node.attr(alias) === undefined) node.attr(alias, value);
      }
    }
    for (const name of (node.attr('class') ?? '').split(/\s+/)) {
      if (name.startsWith('afterdraft-')) node.addClass(name.replace('afterdraft-', 'profread-'));
    }
  });
  return $;
}

// Saved source HTML can contain legacy application markers and its own styles.
// Keeping both classes preserves those styles while the current bridge uses new names.
export const LEGACY_BRAND_BRIDGE = `document.querySelectorAll('*').forEach(el=>{for(const attr of Array.from(el.attributes)){if(attr.name.startsWith('data-afterdraft-')){const alias=attr.name.replace('data-afterdraft-','data-profread-');if(!el.hasAttribute(alias))el.setAttribute(alias,attr.value)}}for(const name of Array.from(el.classList)){if(name.startsWith('afterdraft-'))el.classList.add(name.replace('afterdraft-','profread-'))}});`;
