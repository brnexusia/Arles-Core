# Importação de cardápio v1.2

A análise de imagem não roda mais dentro da Netlify Function `import-menu`.

Fluxo novo:

```text
Browser -> engine-proxy -> POST /internal/panel/menu/analyze -> 202 + job_id
                                      |
                                      +-> Arles Engine processa IA sem prender o request Netlify

Browser -> engine-proxy -> GET /internal/panel/menu/analyze/:job_id
                         -> processing | done | error
```

Isso elimina o `504 Gateway Timeout` causado pelas duas leituras de visão executadas de forma síncrona na Netlify.

A análise mantém:
- imagem completa;
- recortes ampliados com overlap;
- segunda auditoria para recuperar itens omitidos;
- deduplicação;
- descrições;
- preços e tamanhos globais;
- validação para não inventar produtos.
