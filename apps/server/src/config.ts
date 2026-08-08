import { resolve } from 'node:path';

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
export const config = {
  port: positiveInt(process.env.CO_READER_PORT, 4310),
  dataDir: resolve(process.env.CO_READER_DATA_DIR ?? './data'),
  webDir: resolve(process.env.CO_READER_WEB_DIR ?? './apps/web/dist'),
  password: process.env.CO_READER_PASSWORD ?? '',
  sessionSecret: process.env.CO_READER_SESSION_SECRET ?? '',
  secureCookies: process.env.NODE_ENV === 'production',
  limits: { htmlBytes: 10 * 1024 * 1024, zipBytes: 100 * 1024 * 1024, expandedBytes: 250 * 1024 * 1024, entries: 1000 },
};

export function validateConfig(): void {
  if (!config.password) throw new Error('CO_READER_PASSWORD is required');
  if (config.sessionSecret.length < 32) throw new Error('CO_READER_SESSION_SECRET must contain at least 32 characters');
}
