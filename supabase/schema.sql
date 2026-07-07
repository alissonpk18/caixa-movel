-- =====================================================================
-- PDV · Caixa Rápido — esquema do modo SaaS (Supabase)
--
-- COMO USAR: crie um projeto grátis em https://supabase.com, abra o
-- SQL Editor, cole este arquivo inteiro e clique em "Run". Depois copie
-- a URL do projeto e a chave "anon public" (Settings → API) para o
-- arquivo js/config.js do app.
--
-- Modelo v1: UMA CONTA (e-mail/senha) = UMA LOJA. Todos os aparelhos da
-- loja entram com a mesma conta; os logins de operador (gerente/caixa)
-- continuam sendo os do próprio app, sincronizados como dados da loja.
-- O isolamento entre lojas é garantido por Row Level Security (RLS):
-- cada conta só consegue ler e escrever as linhas da própria loja,
-- mesmo que o código do cliente seja alterado.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Loja: uma linha por conta. `owner` é o usuário do Supabase Auth.
-- ---------------------------------------------------------------------
create table if not exists public.stores (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null default auth.uid() unique
             references auth.users(id) on delete cascade,
  name       text not null default 'Minha loja',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Produtos: chave natural é (loja, código de barras).
-- ---------------------------------------------------------------------
create table if not exists public.products (
  store_id   uuid not null references public.stores(id) on delete cascade,
  code       text not null,
  name       text not null,
  price      numeric(12,2) not null default 0,
  cost       numeric(12,2),
  qty        integer not null default 0,
  exp        date,
  updated_at timestamptz not null default now(),
  primary key (store_id, code)
);

-- ---------------------------------------------------------------------
-- Vendas: append-only. `data` guarda a venda completa no formato do app
-- (itens, pagamento, troco); as colunas soltas servem para relatórios SQL.
-- ---------------------------------------------------------------------
create table if not exists public.sales (
  store_id uuid not null references public.stores(id) on delete cascade,
  id       text not null,
  at       timestamptz not null,
  operator text not null default '',
  method   text not null default '',
  total    numeric(12,2) not null default 0,
  data     jsonb not null,
  primary key (store_id, id)
);
create index if not exists sales_store_at on public.sales (store_id, at desc);

-- ---------------------------------------------------------------------
-- kv: documentos da loja que o app sincroniza inteiros
-- (chaves usadas hoje: 'users', 'cash', 'settings').
-- ---------------------------------------------------------------------
create table if not exists public.kv (
  store_id   uuid not null references public.stores(id) on delete cascade,
  key        text not null,
  value      jsonb,
  updated_at timestamptz not null default now(),
  primary key (store_id, key)
);

-- ---------------------------------------------------------------------
-- Row Level Security — o coração da multi-tenancy.
-- ---------------------------------------------------------------------

-- id da loja do usuário logado (security definer para poder consultar
-- stores dentro das políticas das outras tabelas sem recursão de RLS)
create or replace function public.my_store_id()
returns uuid
language sql stable security definer
set search_path = public
as $$ select id from public.stores where owner = auth.uid() $$;

alter table public.stores   enable row level security;
alter table public.products enable row level security;
alter table public.sales    enable row level security;
alter table public.kv       enable row level security;

drop policy if exists "own store"    on public.stores;
create policy "own store" on public.stores
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists "own products" on public.products;
create policy "own products" on public.products
  for all to authenticated
  using (store_id = public.my_store_id())
  with check (store_id = public.my_store_id());

drop policy if exists "own sales"    on public.sales;
create policy "own sales" on public.sales
  for all to authenticated
  using (store_id = public.my_store_id())
  with check (store_id = public.my_store_id());

drop policy if exists "own kv"       on public.kv;
create policy "own kv" on public.kv
  for all to authenticated
  using (store_id = public.my_store_id())
  with check (store_id = public.my_store_id());

-- mantém updated_at correto em upserts
create or replace function public.touch_updated_at()
returns trigger language plpgsql as
$$ begin new.updated_at = now(); return new; end $$;

drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

drop trigger if exists kv_touch on public.kv;
create trigger kv_touch before update on public.kv
  for each row execute function public.touch_updated_at();
