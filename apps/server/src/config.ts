import { resolve } from 'node:path';

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
/** Legacy variables keep existing installations and archived recovery environments usable. */
export function applicationEnv(name: string): string | undefined {
  return process.env[`PROFREAD_${name}`] ?? process.env[`AFTERDRAFT_${name}`];
}
export const config = {
  port: positiveInt(applicationEnv('PORT'), 4310),
  dataDir: resolve(applicationEnv('DATA_DIR') ?? './data'),
  webDir: resolve(applicationEnv('WEB_DIR') ?? './apps/web/dist'),
  password: applicationEnv('PASSWORD') ?? '',
  sessionSecret: applicationEnv('SESSION_SECRET') ?? '',
  backgroundJobsEnabled: applicationEnv('BACKGROUND_JOBS') !== 'disabled',
  secureCookies: process.env.NODE_ENV === 'production',
  academicWorkerUrl: process.env.ACADEMIC_WORKER_URL ?? 'http://academic-worker:4312',
  limits: { htmlBytes: 10 * 1024 * 1024, zipBytes: 100 * 1024 * 1024, workerResponseBytes: 250 * 1024 * 1024, expandedBytes: 250 * 1024 * 1024, entries: 1000 },
};

export function validateConfig(): void {
  if (!config.password) throw new Error('PROFREAD_PASSWORD is required');
  if (config.sessionSecret.length < 32) throw new Error('PROFREAD_SESSION_SECRET must contain at least 32 characters');
}
