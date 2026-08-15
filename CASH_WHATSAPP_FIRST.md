# Arles Cash — WhatsApp-first

## Modelo

- O Arles mantém uma única instância Evolution conectada ao número oficial do Cash.
- O cliente não conecta WhatsApp e não lê QR Code.
- O número remetente identifica a conta.
- No primeiro contato, o Core cria a conta e inicia o trial de 7 dias automaticamente.
- O primeiro fluxo é: mensagem inicial -> pedir nome -> confirmar trial -> uso normal.

## Variáveis do Core

```env
CASH_EVOLUTION_INSTANCE=instancia-oficial-ja-conectada
CASH_OFFICIAL_NUMBER=5571999999999

CASH_PAYMENT_MONTHLY_URL=https://checkout.exemplo/mensal
CASH_PAYMENT_SEMIANNUAL_URL=https://checkout.exemplo/semestral
CASH_PAYMENT_ANNUAL_URL=https://checkout.exemplo/anual
CASH_PAYMENT_WEBHOOK_SECRET=troque-por-um-segredo-forte
```

`CASH_SIGNUP_URL` não é mais necessário para o onboarding WhatsApp-first e permanece apenas por compatibilidade.

## Planos

| Chave interna | Plano | Preço | Período ativado |
| --- | --- | ---: | ---: |
| `cash_monthly` | Mensal | R$ 4,99 | 1 mês |
| `cash_semiannual` | Semestral | R$ 24,90 | 6 meses |
| `cash_annual` | Anual / Mais popular | R$ 39,90 | 12 meses |

## Webhook de pagamento

Endpoint:

```text
POST /webhooks/cash/payment
```

Autenticação aceita:

```text
Authorization: Bearer CASH_PAYMENT_WEBHOOK_SECRET
```

ou:

```text
X-Cash-Webhook-Secret: CASH_PAYMENT_WEBHOOK_SECRET
```

Payload normalizado recomendado para um adaptador Kirvano/Hotmart/n8n:

```json
{
  "event_id": "evt_123",
  "provider": "kirvano",
  "status": "approved",
  "phone": "5571999999999",
  "plan_key": "cash_annual",
  "amount_cents": 3990
}
```

Status de aprovação aceitos incluem `approved`, `paid`, `complete`, `completed`, `purchase_approved` e `active`.
Eventos de refund/chargeback/cancelamento desativam o acesso sem apagar os dados.

A confirmação procura a conta Cash pelo telefone informado no pagamento e reativa a mesma conta, preservando todos os lançamentos.

## Agendamentos

O worker global do Arles Core executa:

- segunda-feira às 08:00 (UTC-3): relatório da semana anterior;
- dia 1 às 08:00 (UTC-3): relatório do mês anterior;
- dia 5 do trial: aviso de 2 dias restantes;
- dia 7 do trial: relatório semanal + último aviso;
- dia 8: expiração + mensagem de reativação.

Mantenha `JOB_WORKER_INTERVAL_MS` habilitado no Core.

## LP Arles Cash

No projeto `Arles-Cash`, configure:

```env
VITE_CASH_WHATSAPP_NUMBER=5571999999999
```

A CTA abre:

```text
https://wa.me/NUMERO?text=Quero%20come%C3%A7ar
```

A raiz `/` é pública e não exige login. Rotas internas/admin existentes permanecem separadas.
