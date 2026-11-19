# sql-check — valida as migrações num Postgres descartável (PGlite)

Roda as migrações `supabase/migrations/*.sql` **em ordem**, num Postgres em memória (PGlite),
com stubs do que é só do Supabase (papéis `anon/authenticated/service_role`, `auth.uid()`, `storage`).
**Não toca em nenhum banco real.**

## Como rodar
O Node resolve `@electric-sql/pglite` a partir da pasta do script, então rode de uma cópia:

```bash
mkdir /tmp/sql-check && cp scripts/sql-check/*.mjs /tmp/sql-check && cd /tmp/sql-check
npm init -y && npm i @electric-sql/pglite
MIGRATIONS_DIR=/caminho/do/wacrm/supabase/migrations node run-migrations.mjs   # aplica 001..N e lista falhas
MIGRATIONS_DIR=/caminho/do/wacrm/supabase/migrations node test-sql.mjs         # testes funcionais das migrações 053/054
```

## O que cobre (`test-sql.mjs`, 45 verificações)
- 053: telefone opcional, CHECKs de `email_suppressions` / `email_messages`, 1 config por usuário.
- 054: `recency_candidates` (janela, dedupe por e-mail, opt-out, supressão, e-mail inválido, contato só-e-mail, isolamento entre clientes, limite), inscrição única, `regua_report` (tratamento × controle, janela, pedidos não pagos/anteriores, casamento por e-mail), permissões (`service_role` apenas), RLS, desempenho em 20 mil contatos / 20 mil pedidos.

## Limitações conhecidas
- O PGlite não tem a extensão `vector`: as migrações **018, 019 e 020** (IA) falham aqui por isso e são ignoradas pelo `test-sql.mjs`. Não afetam 053/054.
- RLS e permissões usam papéis simulados; confirmar no Supabase real depois de aplicar.
- Ao criar uma migração nova, acrescente os testes dela em `test-sql.mjs`.
