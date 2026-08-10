import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import { db, now, row } from './db/index.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => { const ah = createHash('sha256').update(a).digest(); const bh = createHash('sha256').update(b).digest(); return timingSafeEqual(ah, bh); };

export function registerAuth(app: FastifyInstance): void {
  app.post('/api/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const password = (request.body as { password?: string } | null)?.password ?? '';
    if (!equal(password, config.password)) return reply.code(401).send({ error: 'Invalid credentials' });
    const token = randomBytes(32).toString('base64url'); const csrf = randomBytes(24).toString('base64url'); const id = nanoid();
    const expires = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
    db.prepare('INSERT INTO sessions (id,token_hash,csrf_hash,expires_at,created_at) VALUES (?,?,?,?,?)').run(id, hash(token), hash(csrf), expires, now());
    reply.setCookie('afterdraft_session', token, { httpOnly: true, secure: config.secureCookies, sameSite: 'strict', path: '/', maxAge: 30 * 24 * 3600 });
    reply.setCookie('afterdraft_csrf', csrf, { httpOnly: false, secure: config.secureCookies, sameSite: 'strict', path: '/', maxAge: 30 * 24 * 3600 });
    return { authenticated: true };
  });
  app.post('/api/auth/logout', { preHandler: [authenticate, requireCsrf] }, async (request, reply) => {
    const token = request.cookies.afterdraft_session; if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
    reply.clearCookie('afterdraft_session', { path: '/' }); reply.clearCookie('afterdraft_csrf', { path: '/' }); return { authenticated: false };
  });
  app.get('/api/auth/session', { preHandler: authenticate }, async () => ({ authenticated: true }));
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies.afterdraft_session;
  if (!token || !row('SELECT id FROM sessions WHERE token_hash=? AND expires_at>?', hash(token), now())) { await reply.code(401).send({ error: 'Authentication required' }); }
}
export async function requireCsrf(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!['POST','PUT','PATCH','DELETE'].includes(request.method)) return;
  const token = request.cookies.afterdraft_session; const csrf = request.headers['x-csrf-token'];
  const session = token ? row<{ csrf_hash: string }>('SELECT csrf_hash FROM sessions WHERE token_hash=? AND expires_at>?', hash(token), now()) : undefined;
  if (!session || typeof csrf !== 'string' || !equal(hash(csrf), session.csrf_hash)) await reply.code(403).send({ error: 'Invalid CSRF token' });
}
