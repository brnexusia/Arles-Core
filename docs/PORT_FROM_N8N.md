# Arles Delivery — paridade n8n → Arles Engine

Fonte usada como especificação funcional:

- `ARLES DELIVERY AGENT V3.2 FINAL`
- `ARLES DELIVERY POS-VENDA`

A implementação em código mantém a ideia principal do fluxo estável: **IA interpreta; código decide e grava.**

## Mapeamento

| Comportamento do n8n | Arles Engine |
|---|---|
| Webhook de entrada | `POST /webhooks/evolution` |
| Normalizar Evolution / LID | `src/whatsapp/normalize.ts` |
| Ignorar grupos/broadcast | `core/engine.ts` |
| Deduplicar `message_id` 24h | Redis `onceMessage()` |
| Agrupar mensagens rápidas | Redis `bufferTextMessage()` |
| Pausa quando a loja responde manualmente | Redis + `fromMe` |
| Não pausar em mensagens do próprio Arles | contador `system-sending` |
| Buscar empresa por instância | `core/company.repository.ts` |
| Cliente recorrente | tabela `customers` |
| Memória/contexto recente | `messages` + `conversation_sessions` |
| Configurações | `company_settings` |
| Loja | `delivery_store_info` |
| Produtos ativos | `delivery_products` |
| Variações | `product_variations` |
| Cardápio visual | `menu_assets` + `EvolutionClient.sendImage()` |
| Produto/preço como fonte de verdade | PostgreSQL, nunca saída da IA |
| Interpretação de intenção | `delivery-intent.service.ts` |
| Perguntas gerais | respostas determinísticas + IA grounded |
| Máquina de checkout | `delivery/handler.ts` |
| Uma pergunta por vez | state machine |
| Nome | parser + IA + cliente salvo |
| Entrega/retirada | parser com variações naturais |
| Endereço | state machine + extração |
| Pix/dinheiro/cartão | parser com variações naturais |
| Troco | parser determinístico |
| Resumo | gerado pelo código |
| Confirmação | parser determinístico flexível |
| Recusa/ajuste | parser determinístico |
| INSERT do pedido | transação PostgreSQL |
| Upsert de cliente | mesma transação do pedido |
| Pedido recente confirmado | Redis 24h |
| Evitar reconfirmação | guarda pós-pedido |
| Transbordo humano | detecção + pausa 1h |
| Follow-up único 30 min | Redis sorted set + worker |
| Áudio | Evolution → base64 → OpenAI transcription |
| Imagem comum | Evolution → base64 → análise visual |
| Comprovante Pix | classificação + pedido Pix exato mais recente |
| Prova Pix visível | `media_files` + `GET /media/:token` |
| Status de pedido | `POST /events/order-status` |
| Compatibilidade pós-venda | `POST /webhooks/arles-delivery-events` |
| Dedupe de status | Redis 7 dias |
| Pedido entregue | solicita nota 1–5 |
| Avaliação | `delivery_reviews` |
| Nota 4–5 | pede marcação empresa + `@arlesdelivery` |
| Aprovação/rejeição Pix | `POST /events/payment-status` |

## Melhorias sobre o workflow antigo

### 1. Comprovante Pix

O n8n V3.2 armazenava o comprovante como `data:image/...;base64,...`.

O Engine salva os bytes em `media_files` no PostgreSQL e grava no pedido apenas uma URL:

```text
https://SEU-ENGINE/media/<token>
```

A atualização é feita pelo **ID exato do pedido + company_id**.

### 2. Confirmações e linguagem natural

O parser não depende apenas de `sim`.

Exemplos aceitos:

```text
sim
simm
siim
ss
claro
com certeza
aham
uhum
pode confirmar
pode preparar
isso aí
certinho
beleza
bora
manda ver
```

Também existem variações para:

- entrega/retirada;
- Pix/dinheiro/cartão;
- sem troco;
- menu/cardápio;
- saudações;
- recusa/ajuste;
- transbordo;
- quantidades por extenso;
- avaliações.

### 3. Perguntas comuns sem IA

Preço, disponibilidade, pagamento, taxa, prazo, horário e região de entrega podem ser respondidos diretamente do banco. Isso reduz latência e elimina risco de invenção.

## Endpoints

```text
GET  /health
GET  /media/:token

POST /webhooks/evolution

POST /events/order-status
POST /webhooks/arles-delivery-events
POST /events/payment-status

POST /internal/conversations/pause
POST /internal/conversations/resume
```

Todos os endpoints internos/eventos exigem:

```http
x-arles-key: <INTERNAL_API_KEY>
```

ou:

```http
Authorization: Bearer <INTERNAL_API_KEY>
```

## O que fica fora do motor

A migração do painel/frontend do Supabase para o PostgreSQL próprio é uma etapa separada.

O Engine já está preparado para receber/gravar no PostgreSQL da VPS; o painel precisa passar a ler/escrever por uma API do Arles em vez de acessar o Supabase diretamente.
