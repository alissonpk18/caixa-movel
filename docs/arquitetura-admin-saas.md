# Reestruturação arquitetural — módulo Administrador (SaaS multi-tenant)

Escopo: plano de controle do administrador da plataforma (`admin.html`/`js/admin.js`), modelo
multi-tenant (`supabase/schema.sql`), sessão/vínculo de aparelhos (`js/cloud.js`) e Kill Switch
global. Alvo de dimensionamento: 5.000 empresas, 25.000 aparelhos ativos (gerentes + caixas),
picos de 500 vendas/s agregadas.

---

## 1. Diagnóstico do estado atual (o que quebra em escala)

| # | Ponto | Evidência | Falha em escala |
|---|-------|-----------|-----------------|
| D-01 | RLS resolve o tenant por subconsulta `my_store_id()` (função `security definer` com 2 SELECTs) referenciada em toda política | `supabase/schema.sql:169-178` | O planner não garante initplan para a função; em `IN`/`UPSERT` de lote a resolução roda por linha. Com 25k aparelhos sincronizando, vira o consumidor nº 1 de CPU do Postgres. |
| D-02 | Não existe estado de runtime do tenant. Não há "Modo Offline"; a única revogação é `DELETE` em `device_links`, detectada por polling de 60s (`cloudStillLinked`) | `js/cloud.js:287-297,376` | Kill switch tem latência de até 60s + 1 RTT por aparelho por minuto só para perguntar "ainda estou vinculado?" — 25k consultas/min de puro overhead. |
| D-03 | Console admin escreve direto nas tabelas (`insert/update/delete` em `stores`, `operators`, `device_links`) | `js/admin.js:91,182,196,225,241,258` | Zero trilha de auditoria, zero validação transacional (criar empresa sem gerente é possível), zero evento de propagação. Ações administrativas não são idempotentes nem canceláveis. |
| D-04 | Credencial = SHA-256(`"pdv#v1:"+senha`) sem salt, armazenada e comparada literalmente (`pass_hash <> p_hash`) | `supabase/schema.sql:304`, `js/admin.js:25-33` | Pass-the-hash: o hash **é** a credencial. Vazamento da tabela `operators` = comprometimento de todas as empresas. Sem salt, rainbow table quebra senhas de 4+ chars (mínimo aceito é 4). |
| D-05 | `username` é PK global e o erro de duplicidade é exibido ao admin ("já existe em alguma empresa") | `supabase/schema.sql:133`, `js/admin.js:246-248` | Enumeração cross-tenant e colisão de logins comuns (`caixa1`) entre milhares de empresas. |
| D-06 | Pull integral de produtos/kv/operators/cash_events a cada 60s, sem jitter, sem watermark exceto vendas | `js/cloud.js:309-369,376` | Thundering herd sincronizado no topo do minuto; catálogo de 5k itens × 25k aparelhos = tráfego e I/O de leitura O(N×M) por minuto. |
| D-07 | Push de produtos apaga da nuvem tudo que não existe localmente (`delete ... not in (codes)`) | `js/cloud.js:155-162` | Corrida entre dois aparelhos deleta produtos recém-criados pelo outro; a lista de códigos na URL estoura o limite de querystring com catálogos grandes. |
| D-08 | `sales` e `cash_events` sem particionamento, com `data jsonb` integral | `supabase/schema.sql:73-117` | Crescimento sem poda; vacuum e índices degradam; retenção/LGPD impossível de aplicar por janela. |
| D-09 | Sem rate limit em `login_operator` (executável por `anon`) | `supabase/schema.sql:315` | Oráculo de força bruta distribuída contra todas as contas da plataforma. |
| D-10 | Cliente fala direto com PostgREST; cada aparelho segura conexões do pool compartilhado do Supabase | `js/cloud.js:78` | Sem camada própria de admissão: impossível aplicar quota por tenant, circuit breaker ou cache. Pool é o primeiro recurso a exaurir. |

---

## 2. Decisões arquiteturais

| ID | Decisão | Alternativa rejeitada | Motivo |
|----|---------|----------------------|--------|
| A-01 | Tenant context vai no **JWT** (claims `tid`, `rol`, `epo`) estampado por Custom Access Token Hook; RLS lê claim, não tabela | Manter lookup `device_links` por política | Claim é O(1) por request e initplan-cacheável; lookup por linha é o gargalo D-01 |
| A-02 | Kill Switch = **mudança de 1 linha** (`tenant_runtime.mode`) + fan-out por broadcast; invalidação de sessão em massa = **epoch por tenant** (contador), nunca deleção de N chaves | Deletar/flagar sessões individualmente no Redis | Derrubar 25k sessões vira `INCR` de 1 chave + 1 publish; comparação `jwt.epo >= runtime.auth_epoch` é O(1) no gateway e no banco |
| A-03 | Estado quente (`mode`, `auth_epoch`) em tabela própria `tenant_runtime` (1 linha curta por tenant), separada de `tenants` | Colunas em `tenants` | Linha curta = HOT update, sem write amplification nos índices frios de `tenants`; é a única linha que o caminho quente lê |
| A-04 | Toda mutação administrativa vira **RPC `admin_*`** (`security definer`): valida, muta, audita e publica outbox na mesma transação | Grants diretos nas tabelas para admin | Auditoria e propagação deixam de ser opcionais; superfície de escrita do console cai para um conjunto enumerável de funções |
| A-05 | Verificação de senha **no servidor** com bcrypt sobre o hash do cliente (`crypt(client_hash, salt)`), migração rehash-on-login | Trocar o protocolo do cliente de uma vez | Mantém compatibilidade com a frota instalada (o cliente continua mandando o SHA-256); elimina pass-the-hash a partir do banco sem quebrar ninguém |
| A-06 | `username` único **por tenant** (`unique(tenant_id, username)`); roteamento global de login por tabela `login_directory` mantendo descoberta O(1) | Manter PK global | Resolve colisão e enumeração (D-05) sem perder o onboarding zero-config |
| A-07 | Gateway de sincronização (Edge Functions/serviço stateless) na frente do PostgREST para o caminho de sync, com cache L1 (in-process) + L2 (Redis) do runtime do tenant | Cliente → PostgREST direto para tudo | Ponto único para admissão, quota, colapso de pulls e enforcement do kill switch sem tocar no banco; PostgREST direto permanece só como fallback com RLS como autoridade final |
| A-08 | Pooling em **modo transação** (Supavisor/PgBouncer), RPCs de statement único, `statement_timeout` e `idle_in_transaction_session_timeout` agressivos | Pool em modo sessão | Modo sessão amarra 1 conexão por cliente ocioso — exaustão garantida com 25k aparelhos |
| A-09 | `sales`/`cash_events`/`audit_log` particionadas por RANGE mensal em `at`; retenção por DROP de partição | Tabela única + DELETE por janela | DELETE em massa infla WAL e vacuum; DROP de partição é O(1) |
| A-10 | Sincronização por **watermark + tombstones** (`updated_at > mark`, `deleted_at` soft-delete) e jitter determinístico por aparelho | Pull integral (estado atual) | Corta o tráfego de rotina para o delta real; mata D-06 e D-07 |

---

## 3. Topologia alvo

```
 PWA (caixa/gerente)                      admin.html (console)
      │  HTTPS                                  │  HTTPS + MFA
      ▼                                         ▼
┌───────────────────────────┐        ┌────────────────────────┐
│  Gateway de sincronização │        │  RPCs admin_* (PG)     │
│  (stateless, N réplicas)  │        │  security definer      │
│  - verifica JWT (JWKS)    │        └───────────┬────────────┘
│  - runtime L1→L2→PG       │                    │ mesma tx:
│  - quota/rate por tenant  │                    │ mutação+audit+outbox
│  - colapsa pulls (cache)  │                    ▼
└──────┬──────────┬─────────┘        ┌────────────────────────┐
       │          │                  │ Postgres (Supabase)    │
       │          │ transação        │  tenants/tenant_runtime│
       │          ▼                  │  RLS por claim JWT     │
       │   ┌────────────┐            │  partições sales/audit │
       │   │ Supavisor  │──────────▶ │  outbox (LISTEN/NOTIFY)│
       │   │ (tx mode)  │            └───────────┬────────────┘
       │   └────────────┘                        │ relay
       ▼                                         ▼
┌──────────────┐   pub/sub    ┌──────────────────────────────┐
│ Redis        │◀─────────────│ Fan-out (Supabase Realtime)  │
│ L2 runtime   │              │ canal control:t:{tenant_id}  │
│ rate buckets │              │ canal control:platform       │
└──────────────┘              └──────────────┬───────────────┘
                                             │ websocket
                                       25k aparelhos
```

- **Autoridade**: o Postgres (RLS + checagem de runtime) é sempre a última linha; gateway, Redis e
  Realtime são acelerador e UX, nunca a única barreira.
- O caminho PostgREST direto continua existindo (mesmo RLS), o que permite migração incremental do
  cliente atual sem big-bang.

---

## 4. Esquema de banco (DDL de produção)

```sql
-- extensões
create extension if not exists pgcrypto;   -- crypt()/gen_salt() para bcrypt
create extension if not exists citext;

-- =====================================================================
-- 4.1 Tenants: cadastro (frio) separado do runtime (quente)
-- =====================================================================
create table public.tenants (
  id          uuid primary key default gen_random_uuid(),
  slug        citext not null unique,          -- identificador estável p/ URLs, logs, métricas
  name        text not null,
  contact     text not null default '',
  plan        text not null default 'free',
  status      text not null default 'active'
              check (status in ('provisioning','active','suspended','archived')),
  quota_devices  int not null default 10,
  quota_products int not null default 5000,
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);

-- 1 linha curta por tenant; é a ÚNICA linha lida no caminho quente.
-- fillfactor 70 => updates HOT, sem tocar índice.
create table public.tenant_runtime (
  tenant_id       uuid primary key references public.tenants(id) on delete cascade,
  mode            text not null default 'online' check (mode in ('online','offline')),
  auth_epoch      bigint not null default 1,   -- INCR = invalida toda sessão emitida antes
  mode_changed_at timestamptz not null default now(),
  mode_changed_by uuid
) with (fillfactor = 70);

-- kill switch da PLATAFORMA inteira: singleton, mesma semântica
create table public.platform_runtime (
  singleton   boolean primary key default true check (singleton),
  mode        text not null default 'online' check (mode in ('online','offline')),
  auth_epoch  bigint not null default 1,
  changed_at  timestamptz not null default now(),
  changed_by  uuid
);
insert into public.platform_runtime default values on conflict do nothing;

-- =====================================================================
-- 4.2 Operadores: unicidade POR TENANT + diretório global de roteamento
-- =====================================================================
create table public.operators (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  username      citext not null,
  name          text not null default '',
  role          text not null default 'operador' check (role in ('operador','gerente')),
  can_add_stock boolean not null default false,
  -- bcrypt SOBRE o hash que o cliente envia (SHA-256 "pdv#v1:"+senha).
  -- O valor no banco não serve como credencial (A-05).
  pass_bcrypt   text not null,
  disabled_at   timestamptz,
  updated_at    timestamptz not null default now(),
  unique (tenant_id, username)
);
create index operators_tenant on public.operators (tenant_id) where disabled_at is null;

-- Descoberta O(1) "username → tenant" preservando o onboarding zero-config.
-- Regra de negócio: o login global é reservado por ordem de criação; colisão
-- entre tenants é resolvida na criação (o console sugere sufixo) — nunca no
-- caminho de login.
create table public.login_directory (
  login       citext primary key,
  operator_id uuid not null unique references public.operators(id) on delete cascade
);

-- =====================================================================
-- 4.3 Sessões de aparelho (evolução de device_links): revoga por marca,
-- não por delete — mantém trilha p/ auditoria e evita ressurreição.
-- =====================================================================
create table public.device_sessions (
  auth_uid    uuid primary key references auth.users(id) on delete cascade,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  operator_id uuid references public.operators(id) on delete set null,
  linked_at   timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  revoked_at  timestamptz,
  revoked_by  uuid
);
create index device_sessions_tenant on public.device_sessions (tenant_id)
  where revoked_at is null;

-- =====================================================================
-- 4.4 Auditoria: particionada, append-only, imutável por REVOKE
-- =====================================================================
create table public.audit_log (
  id         bigint generated always as identity,
  at         timestamptz not null default now(),
  tenant_id  uuid,                    -- null = ação de plataforma
  actor_uid  uuid,                    -- auth.users.id (admin ou aparelho)
  actor_kind text not null check (actor_kind in ('platform_admin','device','system')),
  action     text not null,           -- 'tenant.create' | 'tenant.mode.offline' | 'operator.password' ...
  entity     text,
  entity_id  text,
  detail     jsonb not null default '{}'::jsonb,
  request_id text,
  primary key (at, id)
) partition by range (at);

create index audit_tenant_at on public.audit_log (tenant_id, at desc);
revoke update, delete on public.audit_log from public, authenticated, anon;

-- criação de partições mensais (agendar via pg_cron: 1x/dia)
create or replace function public.ensure_month_partitions()
returns void language plpgsql security definer set search_path = public as $$
declare t text; m date;
begin
  foreach t in array array['audit_log','sales','cash_events'] loop
    for i in 0..1 loop
      m := date_trunc('month', now())::date + (i || ' month')::interval;
      execute format(
        'create table if not exists %I partition of %I for values from (%L) to (%L)',
        t || '_' || to_char(m,'YYYYMM'), t, m, m + interval '1 month');
    end loop;
  end loop;
end $$;

-- =====================================================================
-- 4.5 Outbox transacional: propagação do kill switch e de mudanças de
-- operador SEM depender de o publisher estar vivo na hora do commit.
-- =====================================================================
create table public.outbox (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  topic      text not null,       -- 'control:t:{tenant}' | 'control:platform'
  payload    jsonb not null,
  published_at timestamptz
);
create index outbox_pending on public.outbox (id) where published_at is null;

-- =====================================================================
-- 4.6 Dados de negócio: mesmos contratos do app, endurecidos p/ escala
-- =====================================================================
create table public.products (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  code       text not null,
  name       text not null,
  price      numeric(12,2) not null default 0,
  cost       numeric(12,2),
  qty        integer not null default 0,
  exp        date,
  deleted_at timestamptz,                    -- tombstone: mata o "delete not in" (D-07)
  updated_at timestamptz not null default now(),
  primary key (tenant_id, code)
);
-- delta sync: tudo que mudou desde o watermark, inclusive exclusões
create index products_delta on public.products (tenant_id, updated_at);

create table public.sales (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id        text not null,
  at        timestamptz not null,
  operator  text not null default '',
  method    text not null default '',
  total     numeric(12,2) not null default 0,
  data      jsonb not null,
  primary key (tenant_id, id, at)   -- `at` compõe a PK por causa da partição;
                                    -- reenvio idempotente carrega o MESMO at
) partition by range (at);
create index sales_tenant_at on public.sales (tenant_id, at desc);

create table public.cash_events (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id        text not null,
  at        timestamptz not null,
  type      text not null check (type in ('open','sangria','reforco','close')),
  data      jsonb not null,
  primary key (tenant_id, id, at)
) partition by range (at);
create index cash_events_tenant_at on public.cash_events (tenant_id, at);

create table public.kv (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  key        text not null,
  value      jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key)
);

-- =====================================================================
-- 4.7 Rate limit de login (D-09): janela fixa por username e por IP-hash,
-- UNLOGGED (perder no crash é aceitável; nunca entra em WAL/replica).
-- =====================================================================
create unlogged table public.login_attempts (
  bucket_key text not null,          -- 'u:{username}' ou 'ip:{sha1(ip)}'
  window_start timestamptz not null,
  attempts   int not null default 0,
  primary key (bucket_key, window_start)
);
```

### Configuração de pool/timeout (D-10, A-08)

```sql
alter role authenticator set statement_timeout = '5s';
alter role authenticator set idle_in_transaction_session_timeout = '5s';
-- Supavisor: pool_mode=transaction, default_pool_size dimensionado pela
-- lei de Little: 500 req/s de pico × 8ms de mediana ≈ 4 conexões ativas;
-- reservar 40 no pool cobre p99 e rajadas de 10×. Conexões DIRETAS ficam
-- reservadas para o relay do outbox e jobs (pg_cron).
```

---

## 5. Sessão: contexto do tenant no token

### 5.1 Estampagem (Custom Access Token Hook)

O hook roda na emissão/renovação do access token. Access token com TTL de **10 min**: o claim
`epo` congelado no token limita a janela entre "epoch bump" e "token expira" — o enforcement
dentro dessa janela é do gateway/RLS (§6), não do TTL.

```sql
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  claims jsonb := event->'claims';
  ds record;
begin
  select s.tenant_id, o.role, o.can_add_stock, r.auth_epoch, r.mode
    into ds
    from public.device_sessions s
    join public.tenant_runtime r on r.tenant_id = s.tenant_id
    left join public.operators o on o.id = s.operator_id
   where s.auth_uid = (event->>'user_id')::uuid
     and s.revoked_at is null;

  if ds.tenant_id is not null then
    claims := claims
      || jsonb_build_object('tid', ds.tenant_id)
      || jsonb_build_object('rol', coalesce(ds.role,'operador'))
      || jsonb_build_object('stk', coalesce(ds.can_add_stock,false))
      || jsonb_build_object('epo', ds.auth_epoch);
  end if;
  return jsonb_set(event, '{claims}', claims);
end $$;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
```

### 5.2 RLS lendo claim (mata D-01)

Funções `stable` de corpo trivial + **envelopamento em `(select ...)`** nas políticas ⇒ o planner
resolve uma vez por statement (InitPlan), não por linha.

```sql
create or replace function public.jwt_tenant_id() returns uuid
language sql stable as
$$ select nullif(current_setting('request.jwt.claims', true)::jsonb->>'tid','')::uuid $$;

create or replace function public.jwt_epoch() returns bigint
language sql stable as
$$ select coalesce((current_setting('request.jwt.claims', true)::jsonb->>'epo')::bigint, 0) $$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.admins where user_id = auth.uid()) $$;

-- porteiro único: tenant online + plataforma online + epoch do token vigente.
-- 2 lookups por PK, ambos initplan-cacheados por statement.
create or replace function public.tenant_gate() returns boolean
language sql stable security definer set search_path = public as $$
  select r.mode = 'online'
     and p.mode = 'online'
     and public.jwt_epoch() >= r.auth_epoch
     and public.jwt_epoch() >= 0   -- claim ausente => 0 => nega (tenant_gate exige epoch >= r.auth_epoch >= 1)
    from public.tenant_runtime r, public.platform_runtime p
   where r.tenant_id = public.jwt_tenant_id()
$$;

-- padrão de política (repetir para sales, cash_events, kv):
drop policy if exists "tenant products" on public.products;
create policy "tenant products" on public.products
  for all to authenticated
  using (
    (tenant_id = (select public.jwt_tenant_id()) and (select public.tenant_gate()))
    or (select public.is_admin())
  )
  with check (
    (tenant_id = (select public.jwt_tenant_id()) and (select public.tenant_gate()))
    or (select public.is_admin())
  );
```

Consequência importante: **o kill switch é aplicado pelo próprio RLS**. Mesmo um cliente que
ignore o gateway, o broadcast e continue com um JWT válido recebe conjunto vazio/erro na primeira
query após o `mode='offline'` — sem cache intermediário para envenenar.

### 5.3 Login roteado (substitui `login_operator`)

```sql
create or replace function public.login_operator(p_username citext, p_client_hash text)
returns table (tenant_id uuid, name text, role text, can_add_stock boolean)
language plpgsql security definer set search_path = public as $$
declare
  op record; win timestamptz := date_trunc('minute', now());
  tries int;
begin
  if auth.uid() is null then return; end if;

  -- rate limit: 10 tentativas/min por username (constante mesmo em erro)
  insert into public.login_attempts (bucket_key, window_start, attempts)
  values ('u:' || lower(p_username), win, 1)
  on conflict (bucket_key, window_start)
    do update set attempts = login_attempts.attempts + 1
  returning attempts into tries;
  if tries > 10 then
    raise exception 'rate_limited' using errcode = '54000';
  end if;

  select o.id, o.tenant_id, o.name, o.role, o.can_add_stock, o.pass_bcrypt,
         r.mode as t_mode, p.mode as p_mode
    into op
    from public.login_directory d
    join public.operators o on o.id = d.operator_id and o.disabled_at is null
    join public.tenant_runtime r on r.tenant_id = o.tenant_id
    cross join public.platform_runtime p
   where d.login = p_username;

  -- comparação SEMPRE executa um crypt() (timing uniforme p/ user inexistente)
  if op.id is null
     or op.pass_bcrypt <> crypt(p_client_hash, coalesce(op.pass_bcrypt, gen_salt('bf', 10)))
  then
    return; -- login/senha inválidos: mesma resposta, mesmo custo
  end if;

  if op.t_mode <> 'online' or op.p_mode <> 'online' then
    raise exception 'tenant_offline' using errcode = 'P0002';
  end if;

  insert into public.device_sessions (auth_uid, tenant_id, operator_id)
  values (auth.uid(), op.tenant_id, op.id)
  on conflict (auth_uid) do update
    set tenant_id = excluded.tenant_id, operator_id = excluded.operator_id,
        linked_at = now(), revoked_at = null, revoked_by = null;

  insert into public.audit_log (tenant_id, actor_uid, actor_kind, action, entity, entity_id)
  values (op.tenant_id, auth.uid(), 'device', 'device.link', 'operator', op.id::text);

  return query select op.tenant_id, op.name, op.role, op.can_add_stock;
end $$;
grant execute on function public.login_operator(citext, text) to anon, authenticated;
```

Após o vínculo, o cliente **força refresh do token** (`supabase.auth.refreshSession()`) para
receber os claims `tid/rol/epo` — sem isso a primeira sincronização falharia no RLS.

Migração de senha (D-04): coluna `pass_bcrypt` recebe `crypt(sha256_atual, gen_salt('bf',10))`
num backfill único — o valor legado que o cliente envia continua funcionando, e o banco deixa de
guardar credencial utilizável. Nenhuma mudança no app instalado.

---

## 6. Kill Switch global

### 6.1 Máquina de estados do tenant

```
                       admin_set_tenant_mode('offline')
        ┌─────────┐  ──────────────────────────────────▶  ┌──────────┐
        │ online  │                                       │ offline  │
        └─────────┘  ◀──────────────────────────────────  └──────────┘
             ▲          admin_set_tenant_mode('online')        │
             │                                                 │
  status do cadastro (ortogonal): provisioning → active → suspended → archived
  suspended/archived implicam mode=offline forçado (trigger abaixo)
```

- `mode` (runtime) responde "os aparelhos podem falar agora?" — muda em milissegundos, N vezes.
- `status` (cadastro) responde "o contrato existe?" — muda raramente, com workflow.
- `auth_epoch` é ortogonal aos dois: é a primitiva de **revogação de sessão em massa**.

### 6.2 RPC do kill switch (mutação + auditoria + outbox atômicos)

```sql
create or replace function public.admin_set_tenant_mode(
  p_tenant uuid, p_mode text, p_revoke_sessions boolean default false
) returns void
language plpgsql security definer set search_path = public as $$
declare v_epoch bigint;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_mode not in ('online','offline') then
    raise exception 'invalid mode';
  end if;

  update public.tenant_runtime
     set mode = p_mode,
         auth_epoch = auth_epoch + (case when p_revoke_sessions then 1 else 0),
         mode_changed_at = now(),
         mode_changed_by = auth.uid()
   where tenant_id = p_tenant
   returning auth_epoch into v_epoch;
  if not found then raise exception 'tenant not found'; end if;

  insert into public.audit_log (tenant_id, actor_uid, actor_kind, action, detail)
  values (p_tenant, auth.uid(), 'platform_admin', 'tenant.mode.' || p_mode,
          jsonb_build_object('revoke_sessions', p_revoke_sessions, 'epoch', v_epoch));

  insert into public.outbox (topic, payload)
  values ('control:t:' || p_tenant,
          jsonb_build_object('type','mode','mode',p_mode,'epoch',v_epoch,'at',now()));

  notify outbox_wakeup;  -- acorda o relay sem polling
end $$;
grant execute on function public.admin_set_tenant_mode(uuid, text, boolean) to authenticated;

-- plataforma inteira: exatamente 1 UPDATE + 1 evento, independente de N tenants
create or replace function public.admin_set_platform_mode(
  p_mode text, p_revoke_sessions boolean default false
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.platform_runtime
     set mode = p_mode,
         auth_epoch = auth_epoch + (case when p_revoke_sessions then 1 else 0),
         changed_at = now(), changed_by = auth.uid();
  insert into public.audit_log (actor_uid, actor_kind, action)
  values (auth.uid(), 'platform_admin', 'platform.mode.' || p_mode);
  insert into public.outbox (topic, payload)
  values ('control:platform', jsonb_build_object('type','mode','mode',p_mode,'at',now()));
  notify outbox_wakeup;
end $$;
grant execute on function public.admin_set_platform_mode(text, boolean) to authenticated;

-- suspensão de contrato derruba runtime automaticamente
create or replace function public.enforce_status_mode()
returns trigger language plpgsql as $$
begin
  if new.status in ('suspended','archived') and old.status = 'active' then
    update public.tenant_runtime
       set mode = 'offline', auth_epoch = auth_epoch + 1,
           mode_changed_at = now(), mode_changed_by = auth.uid()
     where tenant_id = new.id;
    insert into public.outbox (topic, payload)
    values ('control:t:' || new.id, jsonb_build_object('type','mode','mode','offline','at',now()));
  end if;
  return new;
end $$;
create trigger tenants_status_mode after update of status on public.tenants
  for each row execute function public.enforce_status_mode();
```

### 6.3 Fluxo de propagação (latências alvo)

```
t0   admin clica "Modo Offline"
t0+ms   COMMIT: tenant_runtime.mode='offline' (+epoch), audit_log, outbox   ← autoridade
t0+ms   RLS já nega qualquer statement novo do tenant (tenant_gate)         ← enforcement duro
t0+10ms relay lê outbox (acordado por NOTIFY) e publica:
          Redis DEL rt:t:{id}  +  PUBLISH ctrl {tenant,mode}                ← caches L2/L1 caem
          Realtime broadcast em control:t:{id}                              ← UX instantânea
t0+~200ms aparelhos conectados recebem o broadcast: param loops, fecham
          canais, mostram "loja em modo offline" e preservam storage local
t0+10min  último access token estampado antes de t0 expira (teto absoluto
          mesmo p/ aparelho surdo a broadcast — que de todo modo já era
          negado pelo RLS a cada tentativa)
```

Três camadas independentes; nenhuma delas sozinha é ponto único de falha do enforcement:

| Camada | Latência | Papel | Se falhar |
|--------|----------|-------|-----------|
| RLS (`tenant_gate`) | 0 (próximo statement) | autoridade | não falha isolada do resto do banco |
| Gateway + Redis epoch/mode | ~10 ms | corta a carga antes do banco | requests vazam para o RLS, que nega |
| Realtime broadcast | ~200 ms | derrubar UX/websocket na hora | polling de sync recebe `TENANT_OFFLINE` no próximo ciclo |

### 6.4 Relay do outbox (worker, TypeScript)

```ts
// relay.ts — processo único (ou líder eleito via lock advisory) com conexão direta
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import Redis from "ioredis";

const sql = postgres(process.env.DATABASE_URL!, { max: 2 });
const redis = new Redis(process.env.REDIS_URL!);
const rt = createClient(process.env.SUPABASE_URL!, process.env.SERVICE_ROLE_KEY!);

async function drain(): Promise<void> {
  for (;;) {
    // lote pequeno + FOR UPDATE SKIP LOCKED: réplicas concorrentes não se pisam
    const rows = await sql/*sql*/`
      with batch as (
        select id, topic, payload from public.outbox
        where published_at is null
        order by id limit 100
        for update skip locked)
      update public.outbox o set published_at = now()
      from batch b where o.id = b.id
      returning b.id, b.topic, b.payload`;
    if (rows.length === 0) return;

    for (const r of rows) {
      if (r.topic.startsWith("control:t:")) {
        const tenantId = r.topic.slice("control:t:".length);
        await redis.pipeline()
          .del(`rt:t:${tenantId}`)                       // L2 cai na hora
          .publish("ctrl", JSON.stringify({ tenantId, ...r.payload }))  // L1 das réplicas cai
          .exec();
      } else if (r.topic === "control:platform") {
        await redis.pipeline()
          .set("rt:platform", JSON.stringify(r.payload))
          .publish("ctrl", JSON.stringify({ platform: true, ...r.payload }))
          .exec();
      }
      // fan-out para os aparelhos: 1 publish por evento, N entregas pelo Realtime
      await rt.channel(r.topic).send({
        type: "broadcast", event: "control", payload: r.payload,
      });
    }
  }
}

// LISTEN + varredura periódica (cinto e suspensório p/ NOTIFY perdido)
await sql.listen("outbox_wakeup", () => void drain().catch(console.error));
setInterval(() => void drain().catch(console.error), 5_000);
```

### 6.5 Middleware do gateway (caminho quente, TypeScript)

Resolve D-02 e o gargalo de invalidação em massa: **nenhuma chave por sessão existe**. O estado
consultado é `1 chave por tenant` + `1 chave de plataforma`, e o kill switch invalida por
`DEL`/pub-sub de uma chave — O(1) independente de quantos aparelhos o tenant tenha.

```ts
// runtime-gate.ts
import { LRUCache } from "lru-cache";
import Redis from "ioredis";
import postgres from "postgres";
import { jwtVerify, createRemoteJWKSet } from "jose";

type Runtime = { mode: "online" | "offline"; epoch: number };

const JWKS = createRemoteJWKSet(new URL(`${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
const sub = new Redis(process.env.REDIS_URL!);
const sql = postgres(process.env.DATABASE_URL!, { max: 5, idle_timeout: 30 });

// L1: in-process, TTL curto — absorve os 60s de rajada de sync sem tocar o Redis
const l1 = new LRUCache<string, Runtime>({ max: 20_000, ttl: 3_000 });
let platform: Runtime = { mode: "online", epoch: 1 };

// invalidação L1 por pub/sub: kill switch derruba TODAS as réplicas em 1 publish
await sub.subscribe("ctrl");
sub.on("message", (_ch, msg) => {
  const e = JSON.parse(msg);
  if (e.platform) platform = { mode: e.mode, epoch: e.epoch ?? platform.epoch };
  else l1.delete(e.tenantId);
});

async function tenantRuntime(tenantId: string): Promise<Runtime> {
  const hit = l1.get(tenantId);
  if (hit) return hit;
  try {
    const raw = await redis.get(`rt:t:${tenantId}`);
    if (raw) { const v = JSON.parse(raw) as Runtime; l1.set(tenantId, v); return v; }
  } catch { /* Redis fora: cai direto para o PG (caminho lento, correto) */ }
  const [row] = await sql/*sql*/`
    select mode, auth_epoch as epoch from public.tenant_runtime
    where tenant_id = ${tenantId}`;
  const v: Runtime = row ? { mode: row.mode, epoch: Number(row.epoch) } : { mode: "offline", epoch: Number.MAX_SAFE_INTEGER };
  l1.set(tenantId, v);
  try { await redis.set(`rt:t:${tenantId}`, JSON.stringify(v), "EX", 30); } catch {}
  return v;
}

export async function gate(req: Request): Promise<Response | { tenantId: string; role: string }> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(token, JWKS)); // verificação LOCAL: zero I/O
  } catch {
    return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
  }
  const tenantId = claims.tid as string | undefined;
  const tokenEpoch = Number(claims.epo ?? -1);
  if (!tenantId) return Response.json({ code: "NO_TENANT" }, { status: 403 });

  if (platform.mode === "offline")
    return Response.json({ code: "PLATFORM_OFFLINE" }, { status: 503 });

  const rt = await tenantRuntime(tenantId);
  if (rt.mode === "offline")
    return Response.json({ code: "TENANT_OFFLINE" }, { status: 423 }); // Locked
  if (tokenEpoch < rt.epoch)
    return Response.json({ code: "EPOCH_STALE" }, { status: 401 });    // força refresh; hook re-estampa

  return { tenantId, role: String(claims.rol ?? "operador") };
}
```

Política de falha: Redis indisponível ⇒ degrade para leitura direta do PG (correto, mais lento);
PG indisponível ⇒ **fail-closed** (`503`) — o gateway nunca inventa `online`. O `l1` de 3s limita
o pior caso de staleness do enforcement no gateway a 3s; o RLS por trás não tem staleness nenhuma.

### 6.6 Cliente (evolução de `js/cloud.js`)

```js
/* assina o canal de controle do tenant + o de plataforma logo após vincular */
function cloudSubscribeControl(){
  const onControl = (payload)=>{
    if(payload.type !== "mode") return;
    if(payload.mode === "offline") cloudEnterOfflineMode();
    else cloudLeaveOfflineMode();
  };
  sbClient.channel("control:t:" + cloudStoreId)
    .on("broadcast", { event:"control" }, ({ payload }) => onControl(payload)).subscribe();
  sbClient.channel("control:platform")
    .on("broadcast", { event:"control" }, ({ payload }) => onControl(payload)).subscribe();
}

function cloudEnterOfflineMode(){
  cloudPlatformOffline = true;
  clearTimeout(cloudPushT);                    // congela push; filas locais PERMANECEM
  sbClient.removeAllChannels();                // derruba websockets — "conexão caiu" de verdade
  if(state.user){ logout(); toast("A loja está em modo offline pela plataforma.","bad"); }
}

/* religamento SEM thundering herd: espera determinística por aparelho
   espalha 25k reconexões numa janela de 60s (hash do uid ⇒ offset fixo) */
function cloudLeaveOfflineMode(){
  const spread = (hashCode(deviceUid()) >>> 0) % 60000;
  setTimeout(async ()=>{
    cloudPlatformOffline = false;
    await sbClient.auth.refreshSession();      // re-estampa claims (epoch novo)
    cloudSubscribeControl();
    cloudSync().catch(()=>{});
  }, spread);
}

/* tratamento uniforme dos códigos do gateway/RLS em TODO push/pull:
   TENANT_OFFLINE | PLATFORM_OFFLINE → cloudEnterOfflineMode()
   EPOCH_STALE                       → refreshSession() e 1 retry           */
```

O polling de rotina (`cloudSync`) continua existindo como rede de segurança para aparelho que
perdeu o broadcast (websocket morto, app em background): o primeiro request devolve
`423 TENANT_OFFLINE` e o aparelho entra no mesmo estado. Nada depende só do push.

---

## 7. Gargalos de escala mapeados → solução embutida

| Gargalo | Mecanismo da falha | Solução (onde está) |
|---------|--------------------|---------------------|
| Exaustão do pool de conexões | 25k aparelhos com PostgREST direto + funções por linha seguram conexões e CPU | Supavisor em modo transação, `statement_timeout=5s`, RPCs de statement único, gateway colapsando pulls (§4, A-07/A-08) |
| Invalidação em massa no kill switch | Modelo ingênuo: 1 chave de sessão por aparelho no Redis ⇒ derrubar tenant = SCAN+DEL de milhares de chaves, bloqueando o event loop do Redis | **Epoch por tenant**: derrubar = 1 `UPDATE` + 1 `DEL` + 1 `PUBLISH`, validação O(1) por request (§6.2, §6.5). Não existem chaves por sessão |
| Latência de roteamento de tenant | Resolver tenant por tabela a cada request/linha (D-01) | Claim `tid` no JWT (verificação local por JWKS, zero I/O) + RLS por claim com initplan (§5) |
| Thundering herd de sincronização | Pulls alinhados no minuto + reconexão simultânea pós-kill-switch | Jitter determinístico `hash(uid) % janela` no ciclo e no religamento (§6.6); cache L1 de 3s no gateway absorve o resíduo |
| Fan-out do broadcast | 1 canal global com 25k assinantes para eventos por tenant | Canal **por tenant** (`control:t:{id}`): kill switch de um tenant entrega só aos seus aparelhos; o canal de plataforma só carrega eventos raríssimos (§6.4) |
| Crescimento sem limite de `sales`/`audit` | Vacuum/índices degradam; retenção via DELETE gera bloat | Particionamento mensal por RANGE, retenção por DROP, `ensure_month_partitions` via pg_cron (§4.4, A-09) |
| Tráfego de pull integral | Catálogo inteiro + operators + cash_events a cada 60s por aparelho | Delta por watermark `updated_at > mark` + tombstone `deleted_at` (índice `products_delta`); resposta cacheável por tenant no gateway por 5s — 100 aparelhos do mesmo tenant geram 1 query (§4.6, A-10) |
| Hot tenant / vizinho barulhento | Um tenant com 500 aparelhos degrada o pool para todos | Token bucket por tenant no gateway (Redis `INCR`+`EXPIRE` por chave `rl:t:{id}:{janela}`), quotas em `tenants.quota_*` aplicadas nas RPCs admin e no `login_operator` (contagem de `device_sessions` ativas antes do vínculo) |
| Força bruta no login | RPC pública sem limite (D-09) | Janela fixa em UNLOGGED table + custo constante de `crypt()` + resposta uniforme (§5.3) |

---

## 8. Governança (pontos cegos não citados no cenário)

### 8.1 Auditoria
- Toda mutação administrativa passa por RPC `admin_*` que grava `audit_log` na mesma transação —
  não existe caminho de escrita do console fora disso (grants de tabela revogados do papel do
  console). Ações cobertas: criar/renomear/suspender tenant, modo online/offline, CRUD de
  operador, troca de senha, revogar aparelho, alterar quota.
- `audit_log` é append-only por `REVOKE UPDATE, DELETE`; retenção longa (≥ 5 anos) barata via
  partições; `request_id` correlaciona com logs do gateway.
- Login e vínculo de aparelho também auditam (`device.link`), dando linha do tempo por aparelho.

### 8.2 Segurança
- Console admin: conta e-mail/senha do Supabase Auth com **MFA TOTP obrigatório** (checar
  `auth.jwt()->>'aal' = 'aal2'` dentro de `is_admin()`), sessão de 8h, IP allowlist opcional no
  gateway. Papel `admins` só cresce por migração SQL, nunca por API (política atual mantida).
- Credenciais de operador: bcrypt server-side sobre o hash do cliente (§5.3); rotação do pepper
  do cliente (`pdv#v1:`) versionada no prefixo — `pdv#v2:` pode introduzir salt por usuário
  distribuído no payload de login sem quebrar o parque.
- Enumeração: erro uniforme e custo constante no login; o console valida colisão de
  `login_directory` na criação (sugere `usuario.slug`), nunca expõe a qual empresa pertence um
  login existente.
- Chave `anon` comprometida não dá acesso a dados (RLS nega tudo sem vínculo), mas permite spam
  de `signInAnonymously` — quota de criação de sessões anônimas por IP no gateway.
- `service_role` key vive só no relay e em jobs; nunca em Edge Function exposta a input de
  cliente sem validação de origem.

### 8.3 Isolamento
- Invariante testável: **nenhuma tabela de dados tem política que não comece por
  `tenant_id = jwt_tenant_id()`**. Teste de regressão automatizado (CI) roda com dois JWTs de
  tenants distintos e verifica leitura/escrita cruzada vazia em todas as tabelas — falha de RLS é
  quebra de build, não incidente.
- `tenant_id` presente e NOT NULL em toda tabela de dados (nunca inferido por join), inclusive
  nas partições — o particionamento não altera as políticas (RLS aplica na tabela-mãe).
- Backups/exports por tenant: `copy (select ... where tenant_id = $1)` via job com service role —
  atende portabilidade LGPD e offboarding sem dump global.

### 8.4 Resiliência
- Outbox transacional (§4.5) garante que nenhum evento de controle se perde se o relay cair no
  meio; `FOR UPDATE SKIP LOCKED` permite N réplicas de relay sem duplicação de lote (entrega
  at-least-once; consumidores de controle são idempotentes por natureza — aplicar `mode=offline`
  duas vezes é no-op).
- Cliente já é offline-first com filas idempotentes (`apply_sale`, `adjust_stock`) — preservado.
  Kill switch **não descarta filas locais**: congela o push; ao voltar `online`, as vendas
  represadas sobem pelas mesmas RPCs idempotentes.
- Degradação declarada: Redis fora ⇒ gateway lê PG; gateway fora ⇒ cliente cai para PostgREST
  direto (RLS mantém enforcement); Realtime fora ⇒ polling com jitter detecta o modo pela
  resposta 423. Cada camada falha para a de baixo, nunca para "aberto".
- `pg_cron`: `ensure_month_partitions()` diário; poda de `login_attempts` (> 1h) e de `outbox`
  publicado (> 7 dias); `vacuum (analyze)` fora de pico nas partições correntes.

### 8.5 Concorrência
- Estoque continua mudando **apenas** por RPC relativa/idempotente (`apply_sale`,
  `adjust_stock`, `set_stock` — modelo atual mantido, é o desenho correto); o gatilho
  `protect_product_qty` permanece como cinto de segurança contra upsert absoluto.
- `admin_create_tenant` usa transação única (tenant + runtime + primeiro gerente + directory +
  audit) — impossível existir tenant sem gerente ou sem linha de runtime:

```sql
create or replace function public.admin_create_tenant(
  p_name text, p_slug citext, p_manager_username citext,
  p_manager_name text, p_manager_client_hash text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_op uuid;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;

  insert into public.tenants (name, slug) values (p_name, p_slug) returning id into v_tenant;
  insert into public.tenant_runtime (tenant_id) values (v_tenant);

  insert into public.operators (tenant_id, username, name, role, pass_bcrypt)
  values (v_tenant, p_manager_username, coalesce(p_manager_name, p_manager_username),
          'gerente', crypt(p_manager_client_hash, gen_salt('bf', 10)))
  returning id into v_op;

  insert into public.login_directory (login, operator_id)
  values (p_manager_username, v_op);   -- colisão global ⇒ 23505 ⇒ console sugere sufixo

  insert into public.audit_log (tenant_id, actor_uid, actor_kind, action, entity, entity_id)
  values (v_tenant, auth.uid(), 'platform_admin', 'tenant.create', 'tenant', v_tenant::text);
  return v_tenant;
end $$;
grant execute on function public.admin_create_tenant(text, citext, citext, text, text) to authenticated;
```

- Revogação de aparelho individual (caso "celular perdido" — distinto do kill switch):

```sql
create or replace function public.admin_revoke_device(p_auth_uid uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
  update public.device_sessions
     set revoked_at = now(), revoked_by = auth.uid()
   where auth_uid = p_auth_uid and revoked_at is null
   returning tenant_id into v_tenant;
  if not found then return; end if;
  insert into public.audit_log (tenant_id, actor_uid, actor_kind, action, entity, entity_id)
  values (v_tenant, auth.uid(), 'platform_admin', 'device.revoke', 'device', p_auth_uid::text);
  insert into public.outbox (topic, payload)
  values ('control:t:' || v_tenant,
          jsonb_build_object('type','revoke','auth_uid',p_auth_uid,'at',now()));
  notify outbox_wakeup;
end $$;
```

  O hook de token (§5.1) ignora sessões com `revoked_at` ⇒ o próximo refresh (≤ 10 min) sai sem
  claims e o RLS nega; o broadcast `type:'revoke'` derruba o aparelho na hora se ele estiver
  conectado (cliente compara `auth_uid` local e faz logout).

### 8.6 Observabilidade
- Gateway exporta RED metrics com label `tenant_slug` (cardinalidade controlada: top-N + bucket
  "other"): taxa, erros por código (`TENANT_OFFLINE`, `EPOCH_STALE`, `rate_limited`), latência.
- Métricas de plano de controle: lag do outbox (`min(id) where published_at is null` vs último),
  tempo commit→broadcast (medido pelo relay), sessões ativas por tenant (`device_sessions` com
  `last_seen` recente — o gateway atualiza `last_seen` com upsert amostrado 1/50 requests para
  não gerar write storm).
- Alarmes: lag do outbox > 5s; taxa de `EPOCH_STALE` sustentada (indica loop de refresh);
  `login_attempts` estourando janelas em múltiplos usernames do mesmo IP-hash (credential
  stuffing).

---

## 9. Fluxos de estado consolidados

### 9.1 Vínculo de aparelho (onboarding zero-config, preservado)

```
aparelho novo → signInAnonymously → login local falha → RPC login_operator
  ├─ rate limit ok? ─ não → 54000 (cliente: backoff exponencial)
  ├─ directory hit + bcrypt ok? ─ não → vazio (erro genérico na UI)
  ├─ tenant/platform online? ─ não → P0002 (UI: "loja indisponível")
  └─ upsert device_sessions + audit → refreshSession() → claims tid/rol/epo
        → assina control:t:{tid} + control:platform → pull delta inicial
```

### 9.2 Kill switch (por tenant; plataforma é idêntico com 1 evento)

```
admin → admin_set_tenant_mode(t,'offline',revoke?)
  └─ TX: runtime.mode=offline [+epoch++] + audit + outbox  ── COMMIT
       ├─ (imediato) RLS nega todo statement do tenant
       ├─ relay: DEL rt:t:{t} + PUBLISH ctrl + broadcast control:t:{t}
       │    ├─ gateways: L1 evict → próximos requests 423
       │    └─ aparelhos online: teardown de canais, logout, filas preservadas
       └─ aparelhos offline/surdos: próximo sync → 423/RLS vazio → mesmo estado
volta: admin_set_tenant_mode(t,'online')
  └─ broadcast → cada aparelho espera hash(uid)%60s → refreshSession → sync
     (se houve epoch++: refresh re-estampa epoch novo; access tokens antigos
      morrem sozinhos em ≤10min sem nenhuma escrita por sessão em lugar algum)
```

### 9.3 Ciclo de vida do tenant

```
provisioning ──admin_create_tenant──▶ active ──suspend──▶ suspended ──archive──▶ archived
                                        ▲                    │ (trigger força mode=offline,
                                        └────reactivate──────┘  epoch++, outbox)
archived: dados retidos por N dias p/ export LGPD → job de expurgo por partição/tenant
```

---

## 10. Plano de migração (sem downtime da frota)

1. **Fase 1 — aditiva**: criar `tenants`(view sincronizada de `stores`)/`tenant_runtime`/
   `audit_log`/`outbox`/hook de token; backfill `pass_bcrypt`; RLS ganha `tenant_gate()` em
   modo log-only (função retorna sempre true e registra divergência) por 1 semana.
2. **Fase 2 — corte de leitura**: políticas passam a usar claims (`jwt_tenant_id`); clientes
   antigos sem claim caem no fallback `my_store_id()` mantido dentro de `jwt_tenant_id()`
   (`coalesce(claim, device_sessions lookup)`) até a frota renovar tokens (≤ 1 dia).
3. **Fase 3 — plano de controle**: console admin migra para RPCs `admin_*`; grants diretos
   revogados; relay + canais de controle entram; cliente ganha assinatura de controle e
   tratamento de 423/EPOCH_STALE.
4. **Fase 4 — escala**: gateway de sync com delta/watermark + tombstones; particionamento de
   `sales`/`cash_events` (criação das particionadas + backfill por lote + troca de nome em
   transação); pool para modo transação.
5. Cada fase tem rollback isolado (feature flag por tenant em `kv` da plataforma); a Fase 2 é a
   única com dependência de ordem (hook antes das políticas).
