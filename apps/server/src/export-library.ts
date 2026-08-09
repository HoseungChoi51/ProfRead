import {resolve} from 'node:path';
import {db} from './db/index.js';
import {exportHtmlLibrary} from './exports/library.js';

const output=process.argv[2];
if(!output)throw new Error('Usage: node apps/server/dist/export-library.js OUTPUT_DIRECTORY [EXPORTED_AT]');
try{
  const result=await exportHtmlLibrary(resolve(output),process.argv[3]??new Date().toISOString());
  console.log(JSON.stringify({output:resolve(output),...result}));
}finally{
  db.close();
}
