# Arles Core v1.1 — Integração do painel Delivery

Esta versão move os dados operacionais do Arles Delivery para o Arles Engine/PostgreSQL.

## Arquitetura de transição

```text
Browser
  -> Netlify (engine-proxy, autenticado pelo JWT atual)
  -> Arles Engine
  -> PostgreSQL / Redis / Evolution
```

O Supabase permanece temporariamente somente para:

- login/sessão já existente;
- billing/Stripe já existente;
- identificar `owner_id -> company.id` no proxy;
- copiar uma única vez os dados operacionais antigos para PostgreSQL;
- autenticar a função de extração do cardápio por IA.

Pedidos, clientes, produtos, loja, configurações, cardápio visual e WhatsApp passam a usar o Engine/PostgreSQL.

## Deploy do Engine

1. Aplique o patch v1.1 sobre o repositório `Arles-Core`.
2. Commit/push.
3. No Easypanel, implante `engine`.
4. A migration `004_panel_bridge.sql` é aplicada automaticamente.
5. Confirme:

```text
GET /health
{"ok":true,"service":"arles-engine","version":"1.1.0"}
```

## Variáveis do Engine

As variáveis da v1 continuam. Confira principalmente:

```env
PUBLIC_BASE_URL=https://arles-core-engine.mhnmch.easypanel.host
INTERNAL_API_KEY=UMA_CHAVE_LONGA_E_PRIVADA
```

## Variáveis novas no Netlify do painel

```env
ARLES_ENGINE_URL=https://arles-core-engine.mhnmch.easypanel.host
ARLES_ENGINE_INTERNAL_KEY=O_MESMO_VALOR_DO_INTERNAL_API_KEY_DO_ENGINE
```

Nunca coloque `ARLES_ENGINE_INTERNAL_KEY` em variável `VITE_*`.

## Migração automática do Supabase antigo

Na primeira chamada autenticada do painel:

1. o Netlify valida o JWT do usuário;
2. resolve a empresa por `companies.owner_id`;
3. cria/sincroniza a empresa no Engine usando o mesmo UUID;
4. se ainda não foi migrada, copia os dados operacionais existentes do Supabase;
5. marca a empresa como migrada no PostgreSQL;
6. as chamadas seguintes usam o Engine/PostgreSQL.

A migração é idempotente por empresa (`legacy_supabase_migrated`).

## Checklist depois do deploy do painel

- Login continua funcionando.
- Dashboard mostra pedidos antigos.
- Pedidos mostra pedidos antigos e novos.
- Cardápio mostra produtos existentes.
- Clientes mostra clientes existentes.
- Ajustes/Loja carregam dados existentes.
- WhatsApp mostra o estado da instância existente.
- Um pedido novo pelo WhatsApp aparece no painel.
- Alterar status no painel envia a atualização ao cliente.
- Comprovante PIX aparece no pedido e pode ser aprovado.
- Gerar cardápio visual salva as imagens no Engine.

## Próxima fase

Depois de validar a ponte, a próxima etapa é migrar autenticação e billing para o Arles Core/PostgreSQL. Só então o Supabase pode ser removido totalmente sem exigir reset de senha dos clientes atuais durante esta migração operacional.
