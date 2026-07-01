-- Públicos salvos: permite salvar e reutilizar filtros da página de Públicos.
create table if not exists saved_audiences (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  name        text        not null,
  filters     jsonb       not null,
  created_at  timestamptz not null default now()
);

alter table saved_audiences enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'saved_audiences' and policyname = 'saved_audiences_self'
  ) then
    create policy saved_audiences_self on saved_audiences
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;
