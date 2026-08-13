import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { authService } from './auth.service.js';

function authorized(request: FastifyRequest): boolean {
  if (!env.internalApiKey) return false;
  const direct = String(request.headers['x-arles-key'] ?? '').trim();
  const auth = String(request.headers.authorization ?? '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  return direct === env.internalApiKey || auth === env.internalApiKey;
}

function sessionToken(request: FastifyRequest): string {
  const body = (request.body ?? {}) as Record<string, unknown>;
  return String(
    request.headers['x-arles-session'] ??
    body.session_token ??
    body.sessionToken ??
    ''
  ).trim();
}

function authError(reply: FastifyReply, error: unknown) {
  const code = error instanceof Error ? error.message : String(error);

  if (code === 'INVALID_CREDENTIALS') {
    return reply.code(401).send({ error: 'E-mail ou senha inválidos.', code });
  }
  if (code === 'LOGIN_RATE_LIMITED') {
    return reply.code(429).send({
      error: 'Muitas tentativas de login. Tente novamente em alguns minutos.',
      code
    });
  }
  if (code === 'EMAIL_ALREADY_REGISTERED') {
    return reply.code(409).send({ error: 'Já existe uma conta com este e-mail.', code });
  }
  if (code === 'TRIAL_ALREADY_USED') {
    return reply.code(409).send({
      error: 'Este e-mail ou telefone já utilizou o período gratuito.',
      code
    });
  }
  if (code === 'EMAIL_INVALID') {
    return reply.code(400).send({ error: 'Informe um e-mail válido.', code });
  }
  if (code === 'PHONE_INVALID') {
    return reply.code(400).send({
      error: 'Informe um WhatsApp válido com DDD.',
      code
    });
  }
  if (code === 'PASSWORD_TOO_SHORT') {
    return reply.code(400).send({
      error: 'A senha precisa ter pelo menos 6 caracteres.',
      code
    });
  }
  if (code === 'FIELDS_REQUIRED') {
    return reply.code(400).send({ error: 'Preencha todos os campos obrigatórios.', code });
  }
  if (code === 'VERTICAL_REQUIRED' || code === 'VERTICAL_NOT_FOUND') {
    return reply.code(400).send({ error: 'Vertical inválida ou indisponível.', code });
  }

  console.error('[Auth]', error);
  return reply.code(500).send({ error: 'AUTH_INTERNAL_ERROR', code });
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/internal/auth/register', async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const body = (request.body ?? {}) as any;
      const result = await authService.register({
        name: String(body.name ?? ''),
        companyName: String(body.company_name ?? body.companyName ?? ''),
        email: String(body.email ?? ''),
        phone: String(body.phone ?? ''),
        password: String(body.password ?? ''),
        verticalId: String(body.vertical_id ?? body.verticalId ?? '')
      });
      return reply.send({
        ok: true,
        session_token: result.sessionToken,
        user: result.user
      });
    } catch (error) {
      return authError(reply, error);
    }
  });

  app.post('/internal/auth/login', async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const body = (request.body ?? {}) as any;
      const result = await authService.login(
        String(body.email ?? ''),
        String(body.password ?? '')
      );
      return reply.send({
        ok: true,
        session_token: result.sessionToken,
        user: result.user
      });
    } catch (error) {
      return authError(reply, error);
    }
  });

  app.post('/internal/auth/session', async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const user = await authService.session(sessionToken(request));
    if (!user) return reply.code(401).send({ error: 'SESSION_EXPIRED' });
    return reply.send({ ok: true, user });
  });

  app.post('/internal/auth/logout', async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    await authService.logout(sessionToken(request));
    return reply.send({ ok: true });
  });
}
