import {readFile, readdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import type {Plugin} from 'vite';

// Serve the same local decoding assets in development and production. No PDF
// content or font lookup needs to leave the application's origin.
export function pdfJsAssets(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const prefix = 'assets/pdfjs-6.3.289/';
  const assets = Promise.all(['cmaps', 'standard_fonts', 'wasm', 'iccs'].map(async directory => {
    const names = await readdir(join(root, directory)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' && directory === 'iccs') return [];
      throw error;
    });
    return Promise.all(names.map(async name => [directory + '/' + name, await readFile(join(root, directory, name))] as const));
  })).then(groups => new Map(groups.flat()));
  return {
    name: 'profread-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/' + prefix.slice(0, -1), (request, response, next) => {
        void assets.then(files => {
          const name = request.url?.split('?')[0]?.replace(/^\//, '') ?? '';
          const source = files.get(name);
          if (!source) {next(); return;}
          response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
          response.end(source);
        }).catch(next);
      });
    },
    async generateBundle() {
      for (const [name, source] of await assets) this.emitFile({type: 'asset', fileName: prefix + name, source});
    },
  };
}
