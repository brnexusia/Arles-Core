# Arles Core v2.1.2

Motor multi-tenant e multi-vertical do ecossistema Arles.

O Core centraliza autenticacao, empresas, sessoes, billing, canais, mensagens,
midia, automacoes e infraestrutura. Regras de negocio ficam em modulos de
vertical registrados pelo contrato `VerticalModule`.

## Arquitetura

- `src/core`: recepcao e roteamento de mensagens;
- `src/auth`: cadastro, login e sessoes;
- `src/billing`: assinatura, limites e eventos Stripe;
- `src/media`: processamento e armazenamento global de midia;
- `src/infrastructure`: PostgreSQL e Redis;
- `src/verticals`: contrato, registro e modulos instalados;
- `src/verticals/delivery`: primeira vertical, isolada do motor;
- `migrations/006_vertical_engine.sql`: capabilities, associacao de verticais,
  contatos globais e separacao dos dados Delivery.

## Contrato de vertical

Uma vertical implementa `VerticalModule` e declara:

- identificador, nome, versao e capabilities;
- manipulador de mensagens;
- manipuladores opcionais de midia e interacoes pendentes;
- rotas internas opcionais.

Os modulos oficiais sao registrados em `src/verticals/index.ts`. O servidor,
engine, autenticacao e billing nao precisam conhecer a implementacao de uma
vertical.

## Desenvolvimento

```bash
npm ci
cp .env.example .env
npm run dev
```

## Painel administrativo

O Core fornece `GET /internal/admin/overview`, protegido pela chave interna e
por uma sessao com papel `admin`. A rota reune usuarios, empresas, verticais,
status de assinatura, uso, WhatsApp, receita recorrente ativa e pagamentos
confirmados nos ultimos 30 dias.

Depois do build e das migrations, crie ou atualize o primeiro administrador:

```bash
ADMIN_EMAIL=admin@seudominio.com \
ADMIN_PASSWORD='uma-senha-forte' \
ADMIN_NAME='Administrador' \
npm run admin:create
```

Em desenvolvimento, use `npm run admin:create:dev`. O comando pode ser
executado novamente para trocar a senha.

## Validacao

```bash
npm run typecheck
npm test
npm run build
```

Os testes de fronteira impedem que `server.ts`, `core/engine.ts`, autenticacao
ou billing voltem a importar a implementacao do Delivery.

## Deploy

1. Atualize as variaveis conforme `.env.example`.
2. Implante o Core antes do painel Delivery.
3. O comando de producao aplica as migrations antes de iniciar.
4. Valide `GET /health` e confirme a versao `2.1.2`.
5. Implante o Arles Delivery atualizado para os endpoints modulares.

As migrations sao registradas com checksum. Nao edite migrations ja aplicadas;
adicione uma nova migration para mudancas futuras.
