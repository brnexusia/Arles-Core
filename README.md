# Arles Core — Delivery v1.0

Motor em **Node.js + TypeScript + PostgreSQL + Redis** que substitui o workflow principal do n8n do Arles Delivery.

## Arquitetura

```text
WhatsApp
   ↓
Evolution API
   ↓
Arles Engine
   ├── Core
   ├── Redis
   ├── PostgreSQL
   ├── OpenAI
   └── verticals/
         └── delivery/
```

O mesmo Core foi preparado para receber depois:

```text
beauty
barber
pet
tattoo
studio
```

## Regra principal

A IA serve para **interpretar linguagem** e responder perguntas usando contexto real.

O código controla:

- empresa/tenant;
- estado da conversa;
- produto;
- variação;
- preço;
- quantidade;
- entrega/retirada;
- pagamento;
- confirmação;
- criação do pedido;
- comprovante Pix;
- follow-up;
- pausa humana;
- avaliações;
- pós-venda.

## Delivery v1.0

Incluído:

- texto;
- buffer de mensagens;
- deduplicação;
- áudio + transcrição;
- análise de imagem;
- cardápio visual como imagem;
- cliente recorrente;
- produtos e variações reais;
- perguntas de preço/disponibilidade;
- checkout de uma pergunta por vez;
- linguagem natural/variações de resposta;
- confirmação determinística;
- proteção contra reconfirmar pedido antigo;
- criação do pedido;
- Pix;
- comprovante ligado somente ao pedido correto;
- mídia do comprovante servida pelo Engine;
- pausa quando humano responde;
- transbordo;
- follow-up único de 30 min;
- atualização automática de status;
- avaliação 1–5;
- pedido de marcação para avaliação 4–5;
- migrations automáticas;
- simulator/seed.

## Variáveis do Easypanel

Mantenha as que já existem e adicione:

```env
PUBLIC_BASE_URL=https://SEU-DOMINIO-DO-ENGINE
INTERNAL_API_KEY=UMA_CHAVE_LONGA_E_ALEATORIA

OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe

EVOLUTION_SEND_MEDIA_PATH=/message/sendMedia/{instance}
EVOLUTION_MEDIA_BASE64_PATH=/chat/getBase64FromMediaMessage/{instance}

HUMAN_PAUSE_SECONDS=3600
FOLLOWUP_DELAY_SECONDS=1800
FOLLOWUP_WORKER_INTERVAL_MS=15000
REVIEW_TTL_SECONDS=604800
PIX_PROOF_MAX_AGE_HOURS=8
```

Continuam obrigatórias:

```env
DATABASE_URL=
REDIS_URL=

OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini

EVOLUTION_BASE_URL=
EVOLUTION_API_KEY=

PORT=3000
NODE_ENV=production
```

## Deploy no Easypanel

1. Substitua/adicione os arquivos da v1.0 no repositório GitHub.
2. Commit + Push.
3. Configure as novas variáveis.
4. Clique em **Implantar**.

No startup:

```text
migrations
↓
003_delivery_runtime.sql
↓
servidor
↓
follow-up worker
```

Valide:

```text
GET /health
```

Esperado:

```json
{
  "ok": true,
  "service": "arles-engine",
  "version": "1.0.0"
}
```

## Migrations

O Engine registra cada arquivo em `schema_migrations`.

Nunca edite uma migration já aplicada. Para mudanças futuras, crie:

```text
004_nome.sql
005_nome.sql
...
```

## Seed e simulador

Empresa demo:

```bash
npm run seed:delivery
```

Simulador:

```bash
npm run simulate:delivery
```

Comandos:

```text
/reset
/fresh
/orders
/exit
```

## Pós-venda

Quando o painel mudar um pedido, o backend do painel deve chamar:

```text
POST /events/order-status
```

ou o alias:

```text
POST /webhooks/arles-delivery-events
```

Headers:

```text
x-arles-key: SUA_INTERNAL_API_KEY
content-type: application/json
```

Body:

```json
{
  "company_id": "UUID",
  "order_id": "UUID",
  "status": "Em preparo"
}
```

Status reconhecidos:

```text
Novos
Em preparo
Pronto
Saiu para entrega
Finalizados
Cancelados
```

Ao chegar em `Finalizados`, o Engine envia a pergunta de avaliação e passa a interpretar a próxima resposta de nota.

## Comprovante Pix

Quando chega uma imagem:

```text
imagem
↓
há pedido Pix pendente do mesmo cliente?
↓
SIM
↓
imagem parece comprovante?
↓
SIM
↓
salva em media_files
↓
atualiza APENAS aquele order_id
↓
payment_status = pending_approval
```

O campo `payment_proof_url` recebe uma URL do próprio Engine.

## Pagamento

Para aprovar/rejeitar via backend/painel:

```text
POST /events/payment-status
```

Exemplo:

```json
{
  "company_id": "UUID",
  "order_id": "UUID",
  "payment_status": "approved"
}
```

Valores:

```text
pending
pending_approval
approved
rejected
```

## Pausa humana

Se alguém da loja responde manualmente pelo WhatsApp:

```text
fromMe
↓
não foi mensagem enviada pelo Arles
↓
pausa do bot por 1 hora
```

Também existem endpoints internos:

```text
POST /internal/conversations/pause
POST /internal/conversations/resume
```

## Importante sobre o painel

O **motor do Delivery** está em PostgreSQL próprio.

O frontend atual ainda precisa ser migrado do Supabase para uma API do Arles para que pedidos, clientes, cardápio, status e comprovantes passem a usar este novo banco em produção.

Essa migração do painel é separada do motor do WhatsApp.
