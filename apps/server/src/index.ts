import { buildApp } from './app.js';
import { config, validateConfig } from './config.js';

validateConfig();
const app=await buildApp();
await app.listen({port:config.port,host:'0.0.0.0'});
const shutdown=async()=>{await app.close();process.exit(0);};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
