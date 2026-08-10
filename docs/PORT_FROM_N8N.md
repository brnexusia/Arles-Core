# Mapeamento n8n -> Arles Core

O workflow atual foi tratado como especificação de comportamento.

## Já portado na v0.1

| n8n | Código |
|---|---|
| Webhook Arles | `POST /webhooks/evolution` |
| Normalizar Evento | `src/whatsapp/normalize.ts` |
| Verificar duplicidade | Redis `onceMessage()` |
| Buffer / agrupamento | Redis `bufferTextMessage()` |
| Buscar empresa | `core/company.repository.ts` |
| Buscar cliente | `delivery/repository.ts` |
| Carregar Catálogo Real | `getActiveProducts()` |
| Montar Catálogo Real | catálogo tipado + helpers |
| Interpretar Resposta IA | IA restrita + máquina determinística |
| Ler/Salvar Rascunho | `conversation_sessions` |
| Pedido confirmado? | `isConfirmation()` + state machine |
| Preparar Pedido | validação determinística |
| Criar Pedido | transação PostgreSQL |
| Limpar Rascunho | sessão volta para `idle` |
| Pedido Confirmado Recente | Redis 24h |
| Enviar confirmação | `EvolutionClient.sendText()` |

## Próximas portas

- Imagem e cardápio visual
- Áudio/transcrição
- Comprovante PIX
- Follow-up
- Avaliação
- Pausa humana
- Pós-venda/status
