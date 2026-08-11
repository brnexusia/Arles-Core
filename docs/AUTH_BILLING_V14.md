# Arles Core v1.4 — Auth + Billing

## Objetivo

Mover login, sessões, trial e estado da assinatura para o PostgreSQL do Arles Core.
O Stripe continua sendo o processador de pagamentos; o estado operacional da assinatura passa a ser persistido em `companies` no PostgreSQL do Core.

## Migration automática

A migration `005_auth_billing.sql` cria:

- `auth_users`
- `auth_sessions`
- `trial_entitlements`
- `stripe_events`
- campos Stripe/plano/limites em `companies`

Ela é executada automaticamente no startup pelo runner de migrations existente.

## Login novo

Novos usuários são criados diretamente no Arles Core:

1. cria `companies`;
2. cria `auth_users` com bcrypt;
3. registra o trial de 7 dias;
4. cria sessão opaca;
5. grava somente SHA-256 do token da sessão no banco;
6. envia cookie HttpOnly/Secure ao navegador via Netlify Function.

## Usuários existentes no Supabase

Senha não é migrada em lote. A migração é feita no primeiro login:

1. Engine tenta autenticação nova;
2. se ainda não existe no Core, Netlify valida uma única vez no Supabase Auth;
3. com a senha já fornecida pelo próprio usuário, cria o hash bcrypt no Core;
4. copia company/trial/Stripe para o PostgreSQL;
5. cria a nova sessão;
6. próximos logins usam somente o Core.

Por isso, mantenha temporariamente as variáveis Supabase no Netlify enquanto existirem contas antigas que ainda não fizeram o primeiro login após a v1.4.

## Assinatura

O checkout e portal continuam como Netlify Functions, sem expor a secret key do Stripe ao navegador.

O webhook `/.netlify/functions/webhook-stripe`:

- verifica assinatura do Stripe;
- normaliza eventos;
- envia o evento ao Arles Core;
- Core atualiza `companies` e registra `stripe_events` para idempotência.

Eventos usados:

- `checkout.session.completed`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

## Variáveis

### Easypanel / Engine

Opcional (default 30):

```env
AUTH_SESSION_DAYS=30
```

As variáveis existentes do Engine continuam.

### Netlify

Continuam obrigatórias:

```env
ARLES_ENGINE_URL=https://SEU-ENGINE
ARLES_ENGINE_INTERNAL_KEY=SUA_CHAVE_INTERNA
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
STRIPE_PRICE_ESSENTIAL=...
STRIPE_PRICE_PROFESSIONAL=...
STRIPE_PRICE_SCALE=...
APP_URL=https://SEU-PAINEL
```

Durante a transição de contas antigas, mantenha também:

```env
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Depois que todas as contas antigas tiverem feito um login bem-sucedido na v1.4, o fallback de Auth pode ser removido.

## Teste pós-deploy

1. `/health` deve mostrar `1.4.0`.
2. O deploy do painel pode encerrar a sessão antiga; isso é esperado.
3. Faça login com o mesmo e-mail/senha antigo.
4. Recarregue o painel e confirme que a sessão permanece.
5. Abra Assinatura e confira trial/plano.
6. Teste Checkout e Portal.
7. Teste apagar um produto — a v1.4 também corrige o `DELETE /products/:id` que retornava 400.
