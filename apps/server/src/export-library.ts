import {resolve} from 'node:path';
import {db} from './db/index.js';
import {exportLibrary} from './exports/library.js';

const output=process.argv[2];
if(!output)throw new Error('Usage: node apps/server/dist/export-library.js OUTPUT_DIRECTORY [EXPORTED_AT] [--include-original-pdfs]');
try{
  const exportedAt=process.argv.slice(3).find(value=>!value.startsWith('--'))??new Date().toISOString();
  const result=await exportLibrary(resolve(output),exportedAt,{includeOriginalPdfs:process.argv.includes('--include-original-pdfs')});
  console.log(JSON.stringify({output:resolve(output),...result}));
}finally{
  db.close();
}
