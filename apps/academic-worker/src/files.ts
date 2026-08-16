import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import { WorkerError } from './errors.js';
import { runCommand } from './process.js';

export interface BundleFile {
  path: string;
  bytes: number;
  sha256: string;
}

const defaultOutputLimit = 220 * 1024 * 1024;

export function workerOutputLimit(): number {
  const configured = Number(process.env.ACADEMIC_WORKER_MAX_OUTPUT_BYTES ?? defaultOutputLimit);
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, defaultOutputLimit) : defaultOutputLimit;
}

export async function assertFileWithinWorkerOutputLimit(filePath: string, message = 'Worker output exceeds the response limit.'): Promise<void> {
  if ((await stat(filePath)).size > workerOutputLimit()) throw new WorkerError('output_too_large', message, 422);
}

export async function ensureParent(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureParent(filePath);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function walk(root: string, directory: string, output: BundleFile[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Bundle contains a symbolic link: ${entry.name}`);
    if (entry.isDirectory()) await walk(root, absolute, output);
    else if (entry.isFile()) {
      const details = await stat(absolute);
      output.push({ path: relative(root, absolute).split(sep).join('/'), bytes: details.size, sha256: await sha256File(absolute) });
    }
  }
}

export async function bundleFiles(root: string, excluded = new Set<string>()): Promise<BundleFile[]> {
  const output: BundleFile[] = [];
  await walk(root, root, output);
  return output.filter(file => !excluded.has(file.path));
}

export async function createZip(bundleRoot: string, outputPath: string, signal?: AbortSignal): Promise<void> {
  await runCommand('zip', ['-q', '-r', outputPath, '.'], { cwd: bundleRoot, timeoutMs: 120_000, signal });
}
