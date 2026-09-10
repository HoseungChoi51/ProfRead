import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

import { WorkerError } from './errors.js';

const defaultOutputLimit = 2 * 1024 * 1024;

export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd: string;
  timeoutMs?: number;
  outputLimit?: number;
  signal?: AbortSignal | undefined;
  allowFailure?: boolean;
}

export function workerEnvironment(cwd: string): NodeJS.ProcessEnv {
  const workerHome = process.env.PROFREAD_WORKER_HOME ?? process.env.AFTERDRAFT_WORKER_HOME ?? '/tmp/profread-worker-home';
  const cache = '/tmp/profread-worker-cache';
  const config = '/tmp/profread-worker-config';
  for (const directory of [workerHome, cache, config]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  return {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
    HOME: workerHome,
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: config,
    SAL_USE_VCLPLUGIN: 'svp',
    OMP_THREAD_LIMIT: '2',
    PWD: cwd,
    NO_PROXY: '*',
    no_proxy: '*',
  };
}

function appendBounded(current: Buffer[], chunk: Buffer, state: { bytes: number }, limit: number): void {
  if (state.bytes >= limit) return;
  const remaining = limit - state.bytes;
  const accepted = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
  current.push(accepted);
  state.bytes += accepted.byteLength;
}

function terminateProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already exited */ }
  }
}

export async function runCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const outputLimit = options.outputLimit ?? defaultOutputLimit;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: workerEnvironment(options.cwd),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const stdoutState = { bytes: 0 }, stderrState = { bytes: 0 };
    let settled = false, timedOut = false;

    let force: NodeJS.Timeout | undefined;
    const stop = () => { terminateProcess(child.pid, 'SIGTERM'); force ??= setTimeout(() => terminateProcess(child.pid, 'SIGKILL'), 2_000); };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const abort = () => stop();
    if (options.signal?.aborted) stop(); else options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => appendBounded(stdout, chunk, stdoutState, outputLimit));
    child.stderr.on('data', (chunk: Buffer) => appendBounded(stderr, chunk, stderrState, outputLimit));
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (force) clearTimeout(force);
      options.signal?.removeEventListener('abort', abort);
      reject(new WorkerError('tool_unavailable', `${command} could not be started: ${error.message}`, 503));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (force) clearTimeout(force);
      options.signal?.removeEventListener('abort', abort);
      const result: CommandResult = {
        command,
        args,
        exitCode: code ?? 1,
        durationMs: Date.now() - started,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (options.signal?.aborted) return reject(new WorkerError('request_aborted', 'The request was aborted.', 499));
      if (timedOut) return reject(new WorkerError('tool_timeout', `${command} exceeded ${timeoutMs} ms.`, 422));
      if (code !== 0 && !options.allowFailure) {
        const detail = result.stderr.trim().slice(-2_000);
        return reject(new WorkerError('conversion_failed', `${command} exited with ${code ?? signal ?? 'unknown'}${detail ? `: ${detail}` : ''}`, 422));
      }
      resolve(result);
    });
  });
}
