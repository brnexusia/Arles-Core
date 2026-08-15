# Arles Core v2.2.1

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
- `src/verticals/delivery`: pedidos e cardapio do Arles Delivery;
- `src/verticals/beauty`: agenda e servicos do Arles Beauty;
- `src/verticals/cash`: lancamentos e resumos do Arles Cash;
- `migrations/006_vertical_engine.sql`: capabilities, associacao de verticais,
  contatos globais e separacao dos dados Delivery.

## Contrato de vertical

Uma vertical implementa `VerticalModule` e declara:

- identificador, nome, versao e capabilities;
- manipulador de mensagens;
- manipuladores opcionais de midia e interacoes pendentes;
- rotas internas opcionais;
- tarefas agendadas, onboarding e navegacao opcionais.

Os modulos oficiais sao registrados pelo bootstrap compartilhado. O Delivery mantém
o roteamento conversacional estável por instância, enquanto o Cash usa um canal
central da Arles e resolve a conta pelo número remetente cadastrado.
O engine, autenticacao e billing nao dependem das regras internas de nenhuma
vertical. O worker global executa tarefas declaradas por cada modulo, como os
resumos semanais e mensais do Cash.

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
2. Implante o Core antes dos aplicativos Delivery, Beauty ou Cash.
3. O comando de producao aplica as migrations antes de iniciar.
4. Valide `GET /health` e confirme a versao `2.2.1`.
5. Implante o aplicativo da vertical que sera usada.

As migrations sao registradas com checksum. Nao edite migrations ja aplicadas;
adicione uma nova migration para mudancas futuras.


## WhatsApp: Delivery x Cash

Os dois produtos usam modelos diferentes e não devem ser misturados:

- **Delivery:** cada empresa conecta a própria instância Evolution. O webhook encontra
  a empresa pelo `evolution_instance`.
- **Cash:** a Arles mantém uma única instância central. O cliente somente cadastra
  o próprio número, e o webhook encontra a conta Cash pelo `cash_settings.owner_phone`.

Para o Cash, configure `CASH_EVOLUTION_INSTANCE`, `CASH_OFFICIAL_NUMBER` e
`CASH_SIGNUP_URL`. `CASH_EVOLUTION_INSTANCE` deve apontar para a instância que já
está conectada na Evolution; não é necessário reconectar ou gerar QR Code por cliente.
