import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {pdfJsAssets} from './pdfjs-assets.js';
export default defineConfig({plugins:[react(),pdfJsAssets()],server:{port:4311,proxy:{'/api':'http://localhost:4310','/health':'http://localhost:4310'}},build:{outDir:'dist'}});
