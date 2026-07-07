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

alter table public.stores       enable row level security;
alter table public.products     enable row level security;
alter table public.sales        enable row level security;
alter table public.kv           enable row level security;
alter table public.admins       enable row level security;
alter table public.device_links enable row level security;

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
-- Percorre a lista de usuários de cada empresa (kv.key='users'); para
-- o tamanho esperado de uma plataforma pequena/média isso é rápido o
-- bastante — otimize com um índice dedicado só se um dia isso importar.
-- ---------------------------------------------------------------------
create or replace function public.login_operator(p_username text, p_hash text)
returns table(store_id uuid, name text, role text, can_add_stock boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  rec  record;
  elem jsonb;
begin
  if auth.uid() is null then
    return; -- sem sessão não há a quem vincular o aparelho
  end if;

  for rec in select kv.store_id as sid, kv.value as val from public.kv where key = 'users' loop
    for elem in select * from jsonb_array_elements(coalesce(rec.val, '[]'::jsonb)) loop
      if lower(elem->>'username') = lower(p_username)
         and coalesce(elem->>'passHash','') <> ''
         and elem->>'passHash' = p_hash then
        insert into public.device_links (auth_uid, store_id, username) values (auth.uid(), rec.sid, p_username)
          on conflict (auth_uid) do update
            set store_id = excluded.store_id, username = excluded.username, linked_at = now();
        return query select rec.sid, coalesce(elem->>'name',''), coalesce(elem->>'role','operador'),
          coalesce((elem->>'canAddStock')::boolean, false);
        return;
      end if;
    end loop;
  end loop;
  return; -- nenhuma empresa tem esse usuário/senha
end;
$$;

grant execute on function public.login_operator(text, text) to anon, authenticated;

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
