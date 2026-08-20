/// <reference types="node" />
import {readFile} from 'node:fs/promises';
import {describe,expect,it} from 'vitest';

async function source(path:string):Promise<string>{
  return readFile(new URL(path,import.meta.url),'utf8');
}

describe('ProfRead branding',()=>{
  it('uses the supplied icon and ProfRead name in browser metadata',async()=>{
    const html=await source('../index.html');
    expect(html).toContain('href="/profread_icon.svg"');
    expect(html).toContain('name="application-name" content="ProfRead"');
    expect(html).toContain('<title>ProfRead</title>');
  });

  it('places the supplied horizontal logo on login and library screens',async()=>{
    const[app,library]=await Promise.all([source('./App.tsx'),source('./Library.tsx')]);
    for(const markup of [app,library]){
      expect(markup).toContain('src="/profread_logo.svg"');
      expect(markup).toContain('alt="ProfRead — Ask. Critique. Understand."');
    }
  });

  it('keeps accessible ProfRead metadata in both SVG assets',async()=>{
    const[icon,logo]=await Promise.all([source('../public/profread_icon.svg'),source('../public/profread_logo.svg')]);
    expect(icon).toContain('ProfRead app icon');
    expect(logo).toContain('ProfRead horizontal logo');
    expect(logo).toContain('>ProfRead</text>');
    expect(logo).toContain('Ask. Critique. Understand.');
  });

  it('includes public branding assets in the production container build',async()=>{
    const dockerfile=await source('../../../Dockerfile');
    expect(dockerfile).toContain('COPY apps/web/public ./apps/web/public');
  });
});
