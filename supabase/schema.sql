-- =====================================================================
-- PDV · Caixa Rápido — esquema do modo SaaS (Supabase)
--
-- COMO USAR: crie um projeto grátis em https://supabase.com, abra o
-- SQL Editor, cole este arquivo inteiro e clique em "Run". Depois copie
-- a URL do projeto e a chave "anon public" (Settings → API) para o
-- arquivo js/config.js do app. Habilite também em Authentication →
-- Sign In / Providers → **Anonymous Sign-Ins** (é o que dá a cada
-- aparelho uma identidade para o RLS, sem pedir e-mail de ninguém).
--
-- Modelo: a EMPRESA é criada pelo administrador da plataforma (você)
-- pelo admin.html, que também cadastra o gerente e os caixas de cada
-- uma. O lojista nunca vê uma tela de "conectar à nuvem": o aparelho
-- usa o login de sempre (usuário/senha); se o usuário não existe ainda
-- naquele aparelho, a função login_operator() abaixo descobre a que
-- empresa ele pertence, confere a senha no banco e vincula o aparelho
-- automaticamente (tabela device_links). Da próxima vez o login já
-- resolve local, sem consultar a nuvem de novo.
--
-- O isolamento entre empresas é garantido por Row Level Security (RLS):
-- cada aparelho só lê e escreve as linhas da empresa a que está
-- vinculado, mesmo que o código do cliente seja alterado.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Empresa (loja). Criada pelo admin — sem dono/e-mail obrigatório.
-- ---------------------------------------------------------------------
create table if not exists public.stores (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid unique references auth.users(id) on delete set null,
  name       text not null default 'Minha loja',
  email      text not null default '',
  created_at timestamptz not null default now()
);

-- Migração para bancos criados com o schema v1 — o "create table if not
-- exists" acima NÃO altera uma tabela que já existe. No v1, `owner` era
-- `not null default auth.uid() unique` com `on delete cascade`, o que
-- quebrava o console: a 1ª empresa criada tomava o slot único do owner
-- (o default preenchia o auth.uid() do admin) e TODA criação seguinte
-- falhava com "Não foi possível criar" (unique_violation); além disso,
-- excluir a conta dona apagaria a empresa inteira em cascata. As linhas
-- abaixo são idempotentes: rodar de novo num banco já migrado não muda nada.
alter table public.stores alter column owner drop default;
alter table public.stores alter column owner drop not null;
alter table public.stores drop constraint if exists stores_owner_fkey;
alter table public.stores add constraint stores_owner_fkey
  foreign key (owner) references auth.users(id) on delete set null;

-- ---------------------------------------------------------------------
-- Administradores da PLATAFORMA (você): enxergam e gerenciam todas as
-- lojas pelo console admin.html. Para promover uma conta a admin, crie
-- a conta normalmente pelo app e rode no SQL Editor:
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'seu@email.com';
-- ---------------------------------------------------------------------
create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- continuação da migração v1 de `stores` (precisa de `admins`, por isso
-- vive aqui): desfaz o vínculo indevido que o default antigo criou
-- ("empresa pertence à conta do admin que a criou") — libera o slot único
-- do owner e evita que o aparelho do próprio admin seja roteado para essa
-- empresa por my_store_id(). Idempotente e inócua numa instalação nova.
update public.stores set owner = null
  where owner in (select user_id from public.admins);

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$ select exists (select 1 from public.admins where user_id = auth.uid()) $$;

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
-- (chave usada hoje: 'settings' — 'users' virou `operators', A-03; e
-- 'cash' virou `cash_events' logo abaixo, A-06 — kv.cash só é lido como
-- ponte de migração para quem já tinha caixa aberto antes dessa mudança).
-- ---------------------------------------------------------------------
create table if not exists public.kv (
  store_id   uuid not null references public.stores(id) on delete cascade,
  key        text not null,
  value      jsonb,
  updated_at timestamptz not null default now(),
  primary key (store_id, key)
);

-- ---------------------------------------------------------------------
-- Eventos do caixa (achado A-06): abertura, sangria, reforço e
-- fechamento — append-only, como as vendas. Antes, o caixa inteiro
-- (sessão aberta + movimentos) era UM documento em kv, sincronizado por
-- "última escrita vence"; dois aparelhos mexendo na mesma gaveta ao
-- mesmo tempo faziam um apagar o movimento do outro. Cada ação vira uma
-- linha própria; o estado (DB.cash = {open, history}) é reconstruído no
-- aparelho reproduzindo os eventos em ordem — mesma lógica de sempre em
-- js/pdv-core.js, só a origem dos dados muda.
-- ---------------------------------------------------------------------
create table if not exists public.cash_events (
  store_id uuid not null references public.stores(id) on delete cascade,
  id       text not null,
  at       timestamptz not null,
  type     text not null,  -- 'open' | 'sangria' | 'reforco' | 'close'
  data     jsonb not null,
  primary key (store_id, id)
);
create index if not exists cash_events_store_at on public.cash_events (store_id, at);

-- ---------------------------------------------------------------------
-- Operadores (gerente/caixa) de cada empresa. Antes viviam num array
-- JSON dentro de kv (key='users'), sem nada impedindo duas empresas
-- terem o mesmo login — login_operator() então varria TODAS as
-- empresas linha a linha até achar uma senha que batesse, o que era
-- ambíguo (a "vencedora" era só a ordem de retorno do banco) e ficava
-- mais lento à medida que a plataforma crescesse. Agora `username` é
-- chave primária GLOBAL: o próprio Postgres impede duplicidade entre
-- empresas, e o login vira uma busca por índice em vez de uma varredura.
-- Só o admin escreve aqui (pelo console); o aparelho só lê (via
-- login_operator, que roda com privilégio elevado, e via sincronização
-- normal para os já vinculados).
-- ---------------------------------------------------------------------
create table if not exists public.operators (
  username      text primary key,
  store_id      uuid not null references public.stores(id) on delete cascade,
  name          text not null default '',
  role          text not null default 'operador',
  can_add_stock boolean not null default false,
  pass_hash     text not null,
  updated_at    timestamptz not null default now()
);
create index if not exists operators_store on public.operators(store_id);

-- ---------------------------------------------------------------------
-- Vínculo aparelho↔empresa. Uma linha por sessão anônima (= aparelho);
-- só é escrita pela função login_operator() abaixo (security definer),
-- nunca diretamente pelo cliente — por isso não há política de escrita
-- para o papel authenticated, só de leitura (da própria linha, ou de
-- todas para o admin) e de exclusão (só o admin, para revogar acesso).
--
-- `username` guarda qual login vinculou o aparelho, só para o admin
-- identificar "de quem" é o vínculo na hora de revogar — não é usado
-- para autenticação (quem autentica é login_operator, via hash).
-- ---------------------------------------------------------------------
create table if not exists public.device_links (
  auth_uid  uuid primary key references auth.users(id) on delete cascade,
  store_id  uuid not null references public.stores(id) on delete cascade,
  username  text not null default '',
  linked_at timestamptz not null default now()
);
-- migração segura para instalações que criaram a tabela antes deste campo
alter table public.device_links add column if not exists username text not null default '';

-- ---------------------------------------------------------------------
-- Row Level Security — o coração da multi-tenancy.
-- ---------------------------------------------------------------------

-- id da empresa deste aparelho/sessão: a de que é dono (fluxo legado,
-- se algum dia reintroduzido) ou a que este aparelho está vinculado.
create or replace function public.my_store_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select id from public.stores where owner = auth.uid()),
    (select store_id from public.device_links where auth_uid = auth.uid())
  )
$$;

-- nome da empresa deste aparelho, para exibir na barra superior do PDV.
-- Função própria (em vez de liberar SELECT geral em `stores` a aparelhos)
-- porque a tabela `stores` guarda dados administrativos (owner, email) que
-- um aparelho vinculado não precisa — só o nome, e só o da própria empresa.
create or replace function public.my_store_name()
returns text
language sql stable security definer
set search_path = public
as $$
  select name from public.stores where id = public.my_store_id()
$$;

grant execute on function public.my_store_name() to authenticated;

alter table public.stores       enable row level security;
alter table public.products     enable row level security;
alter table public.sales        enable row level security;
alter table public.kv           enable row level security;
alter table public.admins       enable row level security;
alter table public.device_links enable row level security;
alter table public.operators    enable row level security;
alter table public.cash_events  enable row level security;

-- cada aparelho só vê a própria linha de vínculo (útil para o app saber
-- se já está vinculado/segue vinculado ao abrir); o admin vê todas, para
-- listar os aparelhos de uma empresa no console. A escrita (criar/trocar
-- o vínculo) é só via login_operator(); a exclusão (revogar) é só do admin.
drop policy if exists "own device link" on public.device_links;
create policy "own device link" on public.device_links
  for select to authenticated
  using (auth_uid = auth.uid() or public.is_admin());

drop policy if exists "admin revokes device link" on public.device_links;
create policy "admin revokes device link" on public.device_links
  for delete to authenticated
  using (public.is_admin());

-- cada conta só vê a própria linha de admin (o console usa isto para
-- saber se a conta logada é administradora); ninguém se promove via API
drop policy if exists "self admin" on public.admins;
create policy "self admin" on public.admins
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "own store"    on public.stores;
create policy "own store" on public.stores
  for all to authenticated
  using (owner = auth.uid() or public.is_admin())
  with check (owner = auth.uid() or public.is_admin());

drop policy if exists "own products" on public.products;
create policy "own products" on public.products
  for all to authenticated
  using (store_id = public.my_store_id() or public.is_admin())
  with check (store_id = public.my_store_id() or public.is_admin());

drop policy if exists "own sales"    on public.sales;
create policy "own sales" on public.sales
  for all to authenticated
  using (store_id = public.my_store_id() or public.is_admin())
  with check (store_id = public.my_store_id() or public.is_admin());

drop policy if exists "own kv"       on public.kv;
create policy "own kv" on public.kv
  for all to authenticated
  using (store_id = public.my_store_id() or public.is_admin())
  with check (store_id = public.my_store_id() or public.is_admin());

drop policy if exists "own cash events" on public.cash_events;
create policy "own cash events" on public.cash_events
  for all to authenticated
  using (store_id = public.my_store_id() or public.is_admin())
  with check (store_id = public.my_store_id() or public.is_admin());

-- aparelho vinculado LÊ os operadores da própria empresa (é assim que
-- recebe gerente/caixa cadastrados ou alterados no console); só o admin
-- escreve (cadastrar, trocar senha, revogar acesso, remover).
drop policy if exists "device reads own operators" on public.operators;
create policy "device reads own operators" on public.operators
  for select to authenticated
  using (store_id = public.my_store_id() or public.is_admin());

drop policy if exists "admin manages operators" on public.operators;
create policy "admin manages operators" on public.operators
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

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

drop trigger if exists operators_touch on public.operators;
create trigger operators_touch before update on public.operators
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- login_operator: a ponte entre "usuário/senha" e "de qual empresa é".
--
-- Roda com os privilégios do dono do banco (security definer), então
-- consegue procurar em TODAS as empresas — é o único lugar do sistema
-- com esse poder, e por isso é cuidadoso: confere a senha (mesmo hash
-- SHA-256 já usado no app, "pdv#v1:"+senha) antes de revelar qualquer
-- coisa, e só devolve nome/papel/permissão — nunca o hash de ninguém.
-- Se a senha bater, vincula o aparelho (device_links) à empresa; dali
-- em diante o RLS normal libera a sincronização dos dados da empresa.
--
-- Requer uma sessão (mesmo anônima) — é ela quem diz "este aparelho".
-- Busca por chave primária em `operators` (username é único no sistema
-- todo) — O(1) via índice, e sem a ambiguidade de duas empresas
-- poderem cadastrar o mesmo login (o próprio Postgres impede).
-- ---------------------------------------------------------------------
create or replace function public.login_operator(p_username text, p_hash text)
returns table(store_id uuid, name text, role text, can_add_stock boolean)
language plpgsql
security definer
set search_path = public
as $$
declare rec record;
begin
  if auth.uid() is null then
    return; -- sem sessão não há a quem vincular o aparelho
  end if;

  select o.store_id, o.name, o.role, o.can_add_stock, o.pass_hash
    into rec
    from public.operators o
    where o.username = lower(p_username);

  if rec.store_id is null or rec.pass_hash <> p_hash then
    return; -- login não existe ou senha não bate
  end if;

  insert into public.device_links (auth_uid, store_id, username) values (auth.uid(), rec.store_id, p_username)
    on conflict (auth_uid) do update
      set store_id = excluded.store_id, username = excluded.username, linked_at = now();
  return query select rec.store_id, rec.name, rec.role, rec.can_add_stock;
end;
$$;

grant execute on function public.login_operator(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- create_operator: permite que a GERÊNCIA cadastre novos usuários de
-- caixa direto do aparelho, sem depender do console do administrador
-- para esse caso comum do dia a dia. Autenticação por usuário+senha
-- (mesmo padrão do login_operator acima) — não pelo vínculo do aparelho
-- (device_links), que só registra quem logou da última vez que precisou
-- rotear pela nuvem, não quem está logado agora. Só cria `operador`
-- (nunca `gerente`): promover alguém a gerência continua exclusivo do
-- console do admin, para não abrir um jeito de escalar privilégio a
-- partir de um aparelho de loja comprometido.
-- ---------------------------------------------------------------------
create or replace function public.create_operator(
  p_mgr_username text, p_mgr_hash text,
  p_new_username text, p_new_name text, p_new_can_add_stock boolean, p_new_hash text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid;
  v_role  text;
  v_hash  text;
begin
  select o.store_id, o.role, o.pass_hash into v_store, v_role, v_hash
    from public.operators o
    where o.username = lower(p_mgr_username);

  if v_store is null or v_role <> 'gerente' or v_hash <> p_mgr_hash then
    raise exception 'não autorizado';
  end if;

  if p_new_username is null or not (lower(p_new_username) ~ '^[a-z0-9._-]{3,20}$') then
    raise exception 'login inválido';
  end if;
  if coalesce(p_new_hash, '') = '' then
    raise exception 'senha inválida';
  end if;

  insert into public.operators (username, store_id, name, role, can_add_stock, pass_hash)
  values (
    lower(p_new_username), v_store,
    coalesce(nullif(trim(p_new_name), ''), lower(p_new_username)),
    'operador', coalesce(p_new_can_add_stock, false), p_new_hash
  );
end;
$$;

grant execute on function public.create_operator(text, text, text, text, boolean, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Proteção do estoque (achado A-02 do relatório de arquitetura): a
-- quantidade só muda por uma destas três RPCs — nunca por um upsert
-- absoluto qualquer, que a partir de agora só carrega nome/preço/custo/
-- validade. Sem isso, duas vendas simultâneas em aparelhos diferentes
-- podiam se sobrescrever ("última escrita vence") e uma baixa de
-- estoque sumia silenciosamente. O gatilho abaixo barra qty em UPDATE
-- a menos que a própria transação avise (via app.allow_qty_update) que
-- é uma das RPCs abaixo — INSERT (produto novo) não é afetado.
-- ---------------------------------------------------------------------
create or replace function public.protect_product_qty()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'UPDATE' and coalesce(current_setting('app.allow_qty_update', true), '') <> 'true' then
    new.qty := old.qty;
  end if;
  return new;
end;
$$;

drop trigger if exists products_protect_qty on public.products;
create trigger products_protect_qty before update on public.products
  for each row execute function public.protect_product_qty();

-- venda: insere a venda e decrementa os itens vendidos na MESMA transação
-- (atômico) — idempotente: reenviar o mesmo id não duplica a venda nem
-- debita o estoque de novo (basta checar se a linha já existia).
create or replace function public.apply_sale(p_sale jsonb)
returns void
language plpgsql
as $$
declare
  v_store uuid := public.my_store_id();
  item    jsonb;
begin
  if v_store is null then
    raise exception 'sem empresa vinculada';
  end if;

  insert into public.sales (store_id, id, at, operator, method, total, data)
  values (
    v_store, p_sale->>'id', (p_sale->>'ts')::timestamptz,
    coalesce(p_sale->>'operator', ''), coalesce(p_sale->'payment'->>'method', ''),
    coalesce((p_sale->>'total')::numeric, 0), p_sale
  )
  on conflict (store_id, id) do nothing;

  if found then
    perform set_config('app.allow_qty_update', 'true', true);
    for item in select * from jsonb_array_elements(coalesce(p_sale->'items', '[]'::jsonb)) loop
      update public.products
        set qty = greatest(0, qty - coalesce((item->>'qty')::integer, 0))
        where store_id = v_store and code = item->>'code';
    end loop;
  end if;
end;
$$;
grant execute on function public.apply_sale(jsonb) to authenticated;

-- reposição de estoque (botão "+Estoque" do caixa): ajuste RELATIVO,
-- atômico — soma/subtrai em vez de "definir", para não brigar com uma
-- venda ou outra reposição acontecendo ao mesmo tempo em outro aparelho.
create or replace function public.adjust_stock(p_code text, p_delta integer)
returns void
language plpgsql
as $$
declare v_store uuid := public.my_store_id();
begin
  if v_store is null then
    raise exception 'sem empresa vinculada';
  end if;
  perform set_config('app.allow_qty_update', 'true', true);
  update public.products
    set qty = greatest(0, qty + p_delta)
    where store_id = v_store and code = p_code;
end;
$$;
grant execute on function public.adjust_stock(text, integer) to authenticated;

-- correção manual de estoque (edição direta do campo "Estoque" na
-- gerência, ou restauração de backup): define o valor ABSOLUTO — use só
-- quando a intenção é mesmo "fixar em N" (para somar/subtrair, é
-- adjust_stock acima).
create or replace function public.set_stock(p_code text, p_qty integer)
returns void
language plpgsql
as $$
declare v_store uuid := public.my_store_id();
begin
  if v_store is null then
    raise exception 'sem empresa vinculada';
  end if;
  perform set_config('app.allow_qty_update', 'true', true);
  update public.products
    set qty = greatest(0, p_qty)
    where store_id = v_store and code = p_code;
end;
$$;
grant execute on function public.set_stock(text, integer) to authenticated;
