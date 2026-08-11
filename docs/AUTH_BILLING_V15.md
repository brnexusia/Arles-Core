# Auth + Billing v1.5 — clean start

A v1.5 remove toda a lógica de migração de contas Supabase.

Fluxo novo:

- cadastro -> Arles Engine/PostgreSQL;
- criação automática da empresa Delivery;
- trial de 7 dias iniciado no cadastro;
- sessão própria em `auth_sessions` com cookie HttpOnly no painel;
- login -> Arles Engine/PostgreSQL;
- checkout -> Stripe;
- webhook Stripe -> Arles Engine -> `companies`.

A rota `/internal/auth/migrate-legacy` não existe mais.

O Supabase não participa de cadastro/login/sessão/assinatura. Ele pode continuar
configurado temporariamente para qualquer funcionalidade antiga ainda existente no
painel, mas Auth/Billing v1.5 não o consulta.
