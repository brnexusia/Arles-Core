# Arles Core v1.5.5

Motor multi-tenant do ecossistema Arles, atualmente com a vertical Delivery.
Ele centraliza autenticação, sessões, empresas, billing, cardápio, pedidos,
clientes, WhatsApp, IA, follow-up e pós-venda.

Esta árvore consolida a base integral do Core e todos os patches feitos até a
correção de sessão `v1.5.5` de 11/08/2026.

## Stack

- Node.js 22 + TypeScript;
- Fastify;
- PostgreSQL;
- Redis;
- OpenAI;
- Evolution API;
- Vitest.

## Estrutura

- `src/auth`: cadastro, login, sessão assinada e logout;
- `src/billing`: contexto de assinatura e eventos Stripe;
- `src/panel`: API interna consumida pelo Arles Delivery;
- `src/menu`: análise assíncrona e normalização de cardápios;
- `src/verticals/delivery`: regras determinísticas do delivery;
- `src/ai`: interpretação de intenção e resposta conversacional;
- `src/whatsapp`: cliente Evolution e normalização de mensagens;
- `src/workers`: follow-up;
- `migrations`: schema `001_core` até `005_auth_billing`;
- `tests`: cardápio e regras do delivery.

## Atualizações incorporadas

- v1.0: engine Delivery completo, mídia, Pix, follow-up e pós-venda;
- v1.1: integração do painel e migration `004_panel_bridge`;
- v1.2–v1.3: importação de cardápio assíncrona, robusta e deduplicada;
- v1.4: autenticação, trial e billing no PostgreSQL;
- v1.5: fluxo limpo sem migração de contas Supabase;
- v1.5.1: correções finais de cadastro/login;
- v1.5.5: token de sessão assinado com HMAC-SHA256, validado sem depender de
  uma segunda leitura imediata do PostgreSQL. O registro em `auth_sessions`
  permanece para auditoria e o logout revoga o token no Redis.

## Desenvolvimento

```bash
npm install
cp .env.example .env
npm run dev
```

## Validação

```bash
npm run typecheck
npm test
npm run build
```

## Deploy no Easypanel

1. Configure as variáveis de `.env.example`.
2. Use o `Dockerfile` da raiz.
3. Implante o serviço com PostgreSQL e Redis acessíveis.
4. O comando de produção executa as migrations antes de iniciar o servidor.
5. Valide `GET /health`.

Resposta esperada:

```json
{
  "ok": true,
  "service": "arles-engine",
  "version": "1.5.5"
}
```

## Sessão v1.5.5

Defina `AUTH_SESSION_SECRET` com uma chave longa e aleatória. Se a variável não
existir, o Core usa `INTERNAL_API_KEY` como fallback compatível.

O fluxo validado é:

1. `POST /internal/auth/login` cria e grava a sessão;
2. `POST /internal/auth/session` valida assinatura e expiração;
3. o painel mantém o usuário autenticado;
4. logout revoga o token no Redis até a expiração.

## Migrations

As migrations são registradas em `schema_migrations`. Não edite migrations já
aplicadas; novas alterações devem receber um novo número sequencial.
