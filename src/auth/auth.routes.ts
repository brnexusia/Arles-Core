import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { enforceIpLimit, enforceRateLimit } from '../security/rate-limit.js';
import { authService } from './auth.service.js';
import { finalizeBeautyRegistration } from './beauty-registration.js';

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

  if (code === 'RATE_LIMITED' || code === 'LOGIN_RATE_LIMITED') {
    return reply.code(429).send({
      error: 'Muitas tentativas. Tente novamente em alguns minutos.',
      code: 'RATE_LIMITED'
    });
  }
  if (code === 'INVALID_CREDENTIALS') {
    return reply.code(401).send({ error: 'E-mail ou senha inválidos.', code });
  }
  if (code === 'EMAIL_ALREADY_REGISTERED') {
    return reply.code(409).send({ error: 'Já existe uma conta com este e-mail.', code });
  }
  if (code === 'TRIAL_ALREADY_USED') {
    return reply.code(409).send({
      error: 'Este e-mail ou telefone já possui um cadastro anterior.',
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
  app.post('/internal/auth/register', { bodyLimit: 32 * 1024 }, async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const body = (request.body ?? {}) as any;
      const email = String(body.email ?? '').trim().toLowerCase();
      const phone = String(body.phone ?? '').replace(/\D/g, '');
      await enforceIpLimit(request, reply, 'auth:register:ip', 8, 60 * 60);
      await enforceRateLimit({ scope: 'auth:register:email', limit: 3, windowSeconds: 60 * 60, identity: email }, reply);
      if (phone) await enforceRateLimit({ scope: 'auth:register:phone', limit: 3, windowSeconds: 60 * 60, identity: phone }, reply);

      const verticalId = String(body.vertical_id ?? body.verticalId ?? '').trim().toLowerCase();
      const result = await authService.register({
        name: String(body.name ?? ''),
        companyName: String(body.company_name ?? body.companyName ?? ''),
        email,
        phone,
        password: String(body.password ?? ''),
        verticalId
      });

      if (verticalId === 'beauty') {
        await finalizeBeautyRegistration(result.user.companyId, body.acquisition ?? {});
      }

      return reply.send({
        ok: true,
        session_token: result.sessionToken,
        user: result.user
      });
    } catch (error) {
      return authError(reply, error);
    }
  });

  app.post('/internal/auth/login', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const body = (request.body ?? {}) as any;
      const email = String(body.email ?? '').trim().toLowerCase();
      await enforceIpLimit(request, reply, 'auth:login:ip', 30, 15 * 60);
      await enforceRateLimit({ scope: 'auth:login:email', limit: 12, windowSeconds: 15 * 60, identity: email }, reply);
      const result = await authService.login(email, String(body.password ?? ''));
      return reply.send({
        ok: true,
        session_token: result.sessionToken,
        user: result.user
      });
    } catch (error) {
      return authError(reply, error);
    }
  });

  app.post('/internal/auth/session', { bodyLimit: 8 * 1024 }, async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const user = await authService.session(sessionToken(request));
    if (!user) return reply.code(401).send({ error: 'SESSION_EXPIRED' });
    return reply.send({ ok: true, user });
  });

  app.post('/internal/auth/logout', { bodyLimit: 8 * 1024 }, async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    await authService.logout(sessionToken(request));
    return reply.send({ ok: true });
  });
}
