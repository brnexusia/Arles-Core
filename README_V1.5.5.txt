ARLES CORE v1.5.5 — FIX DA SESSÃO NO ENGINE

Diagnóstico confirmado pela v1.5.4:
- /auth-login consegue validar e-mail e senha;
- o Engine cria session_token;
- a própria Netlify tenta validar esse token imediatamente no
  /internal/auth/session;
- essa validação falha e auth-login devolve 502.

Logo, o problema não é mais cookie/browser. É a validação da sessão no Engine.

Correção:
- session_token agora é assinado com HMAC-SHA256;
- contém userId + expiração + nonce;
- /internal/auth/session valida assinatura e expiração sem depender de uma
  segunda leitura imediata de auth_sessions;
- auth_sessions continua sendo gravada para auditoria;
- logout revoga o token no Redis até sua expiração;
- AUTH_SESSION_SECRET é opcional; se não existir, usa INTERNAL_API_KEY.

Não há migration nova.
Não precisa apagar conta.
Não precisa mexer no painel v1.5.4.

Depois do deploy:
1. /health deve mostrar 1.5.5.
2. Faça login.
3. auth-login deve retornar 200 em vez de 502.
4. O onboarding/painel deve permanecer aberto.
