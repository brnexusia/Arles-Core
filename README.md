# Arles Core — Delivery v0.1

Primeira base do **Arles Engine** em código puro.

O objetivo desta versão não é desligar o n8n imediatamente. Ela cria o núcleo que vai substituir o workflow de forma controlada.

## O que já existe

- Webhook HTTP para Evolution API
- Normalização de mensagens
- Mapeamento `instância -> empresa -> vertical`
- Multi-tenant por `company_id`
- Deduplicação de mensagens no Redis
- Buffer curto para mensagens enviadas em sequência
- Lock por empresa + telefone
- Estado da conversa persistido no PostgreSQL
- Primeira vertical: `delivery`
- Catálogo real como fonte de verdade
- Preço sempre lido do PostgreSQL
- Máquina de estados determinística do pedido
- Confirmação determinística
- INSERT de pedido
- Upsert de cliente no mesmo fechamento
- Proteção contra reconfirmar pedido já encerrado
- Integração de texto com Evolution
- IA usada somente para interpretação, não para decidir preço/INSERT
- Healthcheck

## Ainda NÃO ligar no WhatsApp de produção

A v0.1 porta o coração do checkout de texto. Antes de substituir o n8n ainda vamos portar:

1. cardápio visual/imagem;
2. áudio;
3. comprovante PIX;
4. pausa para atendimento humano;
5. follow-up;
6. avaliações;
7. mensagens automáticas de status;
8. importação/migração dos dados atuais;
9. autenticação do painel sem Supabase.

Assim conseguimos comparar o Engine com o workflow atual sem arriscar o Delivery que já funciona.

## Arquitetura

```text
WhatsApp
   ↓
Evolution API
   ↓
POST /webhooks/evolution
   ↓
Arles Engine
   ├── Core
   ├── Redis
   ├── PostgreSQL
   ├── OpenAI
   └── Vertical: Delivery
          ↓
Evolution API
          ↓
WhatsApp
```

## Como subir na VPS

### 1. Copie a pasta para a VPS

Exemplo:

```bash
sudo mkdir -p /opt/arles
sudo chown "$USER":"$USER" /opt/arles
cd /opt/arles
```

Coloque os arquivos do projeto dentro dessa pasta.

### 2. Crie o `.env`

```bash
cp .env.example .env
nano .env
```

Preencha no mínimo:

```env
POSTGRES_PASSWORD=UMA_SENHA_FORTE
OPENAI_API_KEY=...
EVOLUTION_BASE_URL=https://seu-evolution
EVOLUTION_API_KEY=...
```

### 3. Suba

```bash
docker compose up -d --build
```

### 4. Veja os containers

```bash
docker compose ps
```

### 5. Teste o Engine

```bash
curl http://127.0.0.1:3000/health
```

Esperado:

```json
{"ok":true}
```

### 6. Cadastre uma empresa de teste

Entre no PostgreSQL:

```bash
docker compose exec postgres psql -U arles -d arles
```

Exemplo:

```sql
insert into companies (
  name,
  slug,
  vertical,
  evolution_instance,
  subscription_status,
  access_active
) values (
  'Delivery Teste',
  'delivery-teste',
  'delivery',
  'NOME_DA_INSTANCIA_EVOLUTION',
  'active',
  true
);
```

Depois preencha `delivery_store_info` e `delivery_products`.

## Webhook

O endpoint é:

```text
POST /webhooks/evolution
```

Quando formos virar a chave, a Evolution apontará para algo como:

```text
https://engine.seudominio.com/webhooks/evolution
```

O Engine responde `202` imediatamente e processa a mensagem em background dentro do processo.

## Verticalização

Hoje:

```text
src/verticals/delivery
```

Depois:

```text
src/verticals/beauty
src/verticals/barber
src/verticals/pet
src/verticals/tattoo
src/verticals/studio
```

Todos reutilizando:

```text
src/core
src/whatsapp
src/ai
src/infrastructure
```

## Regra principal do Arles Core

A IA interpreta linguagem.

O código controla:

- estado;
- catálogo;
- preço;
- disponibilidade;
- confirmação;
- banco;
- operações.

A IA nunca é a fonte de verdade de um produto ou preço.
