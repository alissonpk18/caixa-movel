-- =====================================================================
-- PDV · Caixa Rápido — dados de demonstração para a "Empresa teste"
--
-- COMO USAR: abra o SQL Editor do seu projeto Supabase, cole este
-- arquivo inteiro e clique em "Run". Ele localiza a empresa pelo nome
-- exato cadastrado no admin.html (variável v_store_name abaixo) e
-- adiciona/atualiza um catálogo maior de produtos, um terceiro
-- operador, histórico de vendas dos últimos dias e o fechamento de
-- caixa desses dias — sem apagar nada que já exista.
--
-- É seguro rodar mais de uma vez: produtos são atualizados (não
-- duplicados), e vendas/eventos de caixa usam IDs fixos, então rodar
-- de novo não cria linhas repetidas.
--
-- O caixa do dia de hoje é deixado FECHADO de propósito, para você
-- poder abrir o caixa ao vivo durante a apresentação.
-- =====================================================================

do $$
declare
  v_store_name text := 'Empresa teste';   -- <-- edite se o nome da sua empresa for outro
  v_store_id   uuid;
  v_pass_1234  text := encode(sha256(convert_to('pdv#v1:1234', 'UTF8')), 'hex');
begin
  select id into v_store_id from public.stores where name = v_store_name limit 1;
  if v_store_id is null then
    raise exception 'Empresa "%" não encontrada em public.stores. Confira o nome exato em admin.html (campo "Nome da empresa") e ajuste v_store_name no topo deste script.', v_store_name;
  end if;

  -- ---------------------------------------------------------------
  -- Catálogo de produtos (mercadinho variado: laticínios, bebidas,
  -- mercearia, padaria, limpeza, higiene) — alguns com estoque baixo
  -- e validade próxima, para demonstrar os alertas do app.
  -- ---------------------------------------------------------------
  perform set_config('app.allow_qty_update', 'true', true);
  insert into public.products (store_id, code, name, price, cost, qty, exp) values
    (v_store_id, '7891000100103', 'Leite Integral 1L',      5.49,  3.80, 40, '2026-07-20'),
    (v_store_id, '7891000053508', 'Biscoito Recheado',      6.49,  4.20, 50, '2026-08-01'),
    (v_store_id, '7896005800010', 'Café Torrado 500g',     16.90, 11.50, 18, '2027-01-10'),
    (v_store_id, '7896036090010', 'Arroz 5kg',             24.90, 19.00, 15, '2027-03-10'),
    (v_store_id, '7891910000197', 'Açúcar Refinado 1kg',    4.29,  2.90, 30, '2026-11-20'),
    (v_store_id, '7894900011517', 'Refrigerante Cola 2L',   8.99,  5.60, 24, '2027-02-15'),
    (v_store_id, '7898080640017', 'Pão de Forma',           7.99,  5.10,  4, '2026-07-12'),
    (v_store_id, '7891150064201', 'Detergente',             2.79,  1.60, 45, null),
    (v_store_id, '7891025101179', 'Iogurte Morango 170g',   3.49,  2.10,  3, '2026-07-14'),
    (v_store_id, '7898930912345', 'Queijo Mussarela 500g', 22.90, 16.80, 10, '2026-07-25'),
    (v_store_id, '7896102500011', 'Suco de Laranja 1L',     6.79,  4.30, 20, '2026-10-05'),
    (v_store_id, '7891991010029', 'Água Mineral 500ml',     2.49,  1.20, 60, '2027-05-01'),
    (v_store_id, '7896023600017', 'Cerveja Pilsen 350ml',   3.99,  2.40, 36, '2026-12-31'),
    (v_store_id, '7896004008019', 'Feijão Carioca 1kg',     8.49,  5.90, 22, '2027-01-20'),
    (v_store_id, '7896036091994', 'Macarrão Espaguete 500g',4.99,  3.10, 28, '2027-04-01'),
    (v_store_id, '7891107101621', 'Óleo de Soja 900ml',     7.49,  5.00, 16, '2027-06-01'),
    (v_store_id, '7891150071155', 'Sabão em Pó 1kg',       12.90,  8.70, 12, null),
    (v_store_id, '7896098700016', 'Papel Higiênico 4un',    9.90,  6.50, 25, null),
    (v_store_id, '7891024131234', 'Sabonete 90g',           1.99,  1.10, 60, null),
    (v_store_id, '7891024135678', 'Creme Dental 90g',       5.49,  3.40, 33, '2027-08-01')
  on conflict (store_id, code) do update set
    name=excluded.name, price=excluded.price, cost=excluded.cost, qty=excluded.qty, exp=excluded.exp;

  -- ---------------------------------------------------------------
  -- Terceiro operador (além do "Caixa teste" e "Gerente teste" que
  -- você já cadastrou), para demonstrar mais de um caixa em operação.
  -- Login: emptcaixa2 · Senha: 1234
  -- ---------------------------------------------------------------
  insert into public.operators (username, store_id, name, role, can_add_stock, pass_hash) values
    ('emptcaixa2', v_store_id, 'Caixa 2 teste', 'operador', false, v_pass_1234)
  on conflict (username) do nothing;

  -- ---------------------------------------------------------------
  -- Vendas de exemplo (6 dias, métodos variados: dinheiro/cartão/pix)
  -- ---------------------------------------------------------------
  insert into public.sales (store_id, id, at, operator, method, total, data) values
    (v_store_id, 'seed-sale-0001', '2026-07-03 09:20:00-03', 'Caixa teste', 'dinheiro', 18.97,
      jsonb_build_object('id','seed-sale-0001','ts','2026-07-03T12:20:00.000Z','operator','Caixa teste','total',18.97,
        'items', jsonb_build_array(
          jsonb_build_object('code','7891000100103','name','Leite Integral 1L','price',5.49,'qty',2),
          jsonb_build_object('code','7898080640017','name','Pão de Forma','price',7.99,'qty',1)),
        'payment', jsonb_build_object('method','dinheiro','received',20.00,'change',1.03))),
    (v_store_id, 'seed-sale-0002', '2026-07-03 11:05:00-03', 'Caixa teste', 'pix', 25.48,
      jsonb_build_object('id','seed-sale-0002','ts','2026-07-03T14:05:00.000Z','operator','Caixa teste','total',25.48,
        'items', jsonb_build_array(
          jsonb_build_object('code','7896005800010','name','Café Torrado 500g','price',16.90,'qty',1),
          jsonb_build_object('code','7891910000197','name','Açúcar Refinado 1kg','price',4.29,'qty',2)),
        'payment', jsonb_build_object('method','pix','received',25.48,'change',0))),
    (v_store_id, 'seed-sale-0003', '2026-07-03 15:40:00-03', 'Gerente teste', 'cartao', 32.39,
      jsonb_build_object('id','seed-sale-0003','ts','2026-07-03T18:40:00.000Z','operator','Gerente teste','total',32.39,
        'items', jsonb_build_array(
          jsonb_build_object('code','7896036090010','name','Arroz 5kg','price',24.90,'qty',1),
          jsonb_build_object('code','7891107101621','name','Óleo de Soja 900ml','price',7.49,'qty',1)),
        'payment', jsonb_build_object('method','cartao','received',32.39,'change',0,'cardType','credito'))),

    (v_store_id, 'seed-sale-0004', '2026-07-04 09:10:00-03', 'Caixa teste', 'dinheiro', 24.47,
      jsonb_build_object('id','seed-sale-0004','ts','2026-07-04T12:10:00.000Z','operator','Caixa teste','total',24.47,
        'items', jsonb_build_array(
          jsonb_build_object('code','7894900011517','name','Refrigerante Cola 2L','price',8.99,'qty',2),
          jsonb_build_object('code','7891000053508','name','Biscoito Recheado','price',6.49,'qty',1)),
        'payment', jsonb_build_object('method','dinheiro','received',25.00,'change',0.53))),
    (v_store_id, 'seed-sale-0005', '2026-07-04 10:30:00-03', 'Caixa 2 teste', 'cartao', 33.37,
      jsonb_build_object('id','seed-sale-0005','ts','2026-07-04T13:30:00.000Z','operator','Caixa 2 teste','total',33.37,
        'items', jsonb_build_array(
          jsonb_build_object('code','7891025101179','name','Iogurte Morango 170g','price',3.49,'qty',3),
          jsonb_build_object('code','7898930912345','name','Queijo Mussarela 500g','price',22.90,'qty',1)),
        'payment', jsonb_build_object('method','cartao','received',33.37,'change',0,'cardType','debito'))),
    (v_store_id, 'seed-sale-0006', '2026-07-04 16:15:00-03', 'Caixa teste', 'pix', 9.47,
      jsonb_build_object('id','seed-sale-0006','ts','2026-07-04T19:15:00.000Z','operator','Caixa teste','total',9.47,
        'items', jsonb_build_array(
          jsonb_build_object('code','7891024131234','name','Sabonete 90g','price',1.99,'qty',2),
          jsonb_build_object('code','7891024135678','name','Creme Dental 90g','price',5.49,'qty',1)),
        'payment', jsonb_build_object('method','pix','received',9.47,'change',0))),
    (v_store_id, 'seed-sale-0007', '2026-07-04 18:50:00-03', 'Gerente teste', 'dinheiro', 23.94,
      jsonb_build_object('id','seed-sale-0007','ts','2026-07-04T21:50:00.000Z','operator','Gerente teste','total',23.94,
        'items', jsonb_build_array(
          jsonb_build_object('code','7896023600017','name','Cerveja Pilsen 350ml','price',3.99,'qty',6)),
        'payment', jsonb_build_object('method','dinheiro','received',25.00,'change',1.06))),

    (v_store_id, 'seed-sale-0008', '2026-07-05 10:00:00-03', 'Caixa 2 teste', 'dinheiro', 16.75,
      jsonb_build_object('id','seed-sale-0008','ts','2026-07-05T13:00:00.000Z','operator','Caixa 2 teste','total',16.75,
        'items', jsonb_build_array(
          jsonb_build_object('code','7891991010029','name','Água Mineral 500ml','price',2.49,'qty',4),
          jsonb_build_object('code','7896102500011','name','Suco de Laranja 1L','price',6.79,'qty',1)),
        'payment', jsonb_build_object('method','dinheiro','received',20.00,'change',3.25))),
    (v_store_id, 'seed-sale-0009', '2026-07-05 13:20:00-03', 'Caixa teste', 'cartao', 18.47,
      jsonb_build_object('id','seed-sale-0009','ts','2026-07-05T16:20:00.000Z','operator','Caixa teste','total',18.47,
        'items', jsonb_build_array(
          jsonb_build_object('code','7896036091994','name','Macarrão Espaguete 500g','price',4.99,'qty',2),
          jsonb_build_object('code','7896004008019','name','Feijão Carioca 1kg','price',8.49,'qty',1)),
        'payment', jsonb_build_object('method','cartao','received',18.47,'change',0,'cardType','credito'))),

    (v_store_id, 'seed-sale-0010', '2026-07-06 09:05:00-03', 'Caixa teste', 'dinheiro', 16.47,
      jsonb_build_object('id','seed-sale-0010','ts','2026-07-06T12:05:00.000Z','operator','Caixa teste','total',16.47,
        'items', jsonb_build_array(
          jsonb_build_object('code','7891000100103','name','Leite Integral 1L','price',5.49,'qty',3)),
        'payment', jsonb_build_object('method','dinheiro','received',17.00,'change',0.53))),
    (v_store_id, 'seed-sale-0011', '2026-07-06 11:45:00-03', 'Gerente teste', 'pix', 22.80,
      jsonb_build_object('id','seed-sale-0011','ts','2026-07-06T14:45:00.000Z','operator','Gerente teste','total',22.80,
        'items', jsonb_build_array(
          jsonb_build_object('code','7896098700016','name','Papel Higiênico 4un','price',9.90,'qty',1),
          jsonb_build_object('code','7891150071155','name','Sabão em Pó 1kg','price',12.90,'qty',1)),
        'payment', jsonb_build_object('method','pix','received',22.80,'change',0))),
    (v_store_id, 'seed-sale-0012', '2026-07-06 17:30:00-03', 'Caixa 2 teste', 'cartao', 22.47,
      jsonb_build_object('id','seed-sale-0012','ts','2026-07-06T20:30:00.000Z','operator','Caixa 2 teste','total',22.47,
        'items', jsonb_build_array(
          jsonb_build_object('code','7898080640017','name','Pão de Forma','price',7.99,'qty',2),
          jsonb_build_object('code','7891000053508','name','Biscoito Recheado','price',6.49,'qty',1)),
        'payment', jsonb_build_object('method','cartao','received',22.47,'change',0,'cardType','debito'))),

    (v_store_id, 'seed-sale-0013', '2026-07-07 09:40:00-03', 'Caixa teste', 'dinheiro', 21.19,
      jsonb_build_object('id','seed-sale-0013','ts','2026-07-07T12:40:00.000Z','operator','Caixa teste','total',21.19,
        'items', jsonb_build_array(
          jsonb_build_object('code','7896005800010','name','Café Torrado 500g','price',16.90,'qty',1),
          jsonb_build_object('code','7891910000197','name','Açúcar Refinado 1kg','price',4.29,'qty',1)),
        'payment', jsonb_build_object('method','dinheiro','received',22.00,'change',0.81))),
    (v_store_id, 'seed-sale-0014', '2026-07-07 12:10:00-03', 'Caixa teste', 'pix', 16.97,
      jsonb_build_object('id','seed-sale-0014','ts','2026-07-07T15:10:00.000Z','operator','Caixa teste','total',16.97,
        'items', jsonb_build_array(
          jsonb_build_object('code','7894900011517','name','Refrigerante Cola 2L','price',8.99,'qty',1),
          jsonb_build_object('code','7896023600017','name','Cerveja Pilsen 350ml','price',3.99,'qty',2)),
        'payment', jsonb_build_object('method','pix','received',16.97,'change',0))),
    (v_store_id, 'seed-sale-0015', '2026-07-07 19:00:00-03', 'Gerente teste', 'cartao', 40.88,
      jsonb_build_object('id','seed-sale-0015','ts','2026-07-07T22:00:00.000Z','operator','Gerente teste','total',40.88,
        'items', jsonb_build_array(
          jsonb_build_object('code','7896036090010','name','Arroz 5kg','price',24.90,'qty',1),
          jsonb_build_object('code','7896004008019','name','Feijão Carioca 1kg','price',8.49,'qty',1),
          jsonb_build_object('code','7891107101621','name','Óleo de Soja 900ml','price',7.49,'qty',1)),
        'payment', jsonb_build_object('method','cartao','received',40.88,'change',0,'cardType','credito'))),

    (v_store_id, 'seed-sale-0016', '2026-07-08 08:50:00-03', 'Caixa teste', 'dinheiro', 13.48,
      jsonb_build_object('id','seed-sale-0016','ts','2026-07-08T11:50:00.000Z','operator','Caixa teste','total',13.48,
        'items', jsonb_build_array(
          jsonb_build_object('code','7891000100103','name','Leite Integral 1L','price',5.49,'qty',1),
          jsonb_build_object('code','7898080640017','name','Pão de Forma','price',7.99,'qty',1)),
        'payment', jsonb_build_object('method','dinheiro','received',14.00,'change',0.52))),
    (v_store_id, 'seed-sale-0017', '2026-07-08 09:30:00-03', 'Caixa 2 teste', 'pix', 29.88,
      jsonb_build_object('id','seed-sale-0017','ts','2026-07-08T12:30:00.000Z','operator','Caixa 2 teste','total',29.88,
        'items', jsonb_build_array(
          jsonb_build_object('code','7891025101179','name','Iogurte Morango 170g','price',3.49,'qty',2),
          jsonb_build_object('code','7898930912345','name','Queijo Mussarela 500g','price',22.90,'qty',1)),
        'payment', jsonb_build_object('method','pix','received',29.88,'change',0))),
    (v_store_id, 'seed-sale-0018', '2026-07-08 10:15:00-03', 'Caixa teste', 'cartao', 14.94,
      jsonb_build_object('id','seed-sale-0018','ts','2026-07-08T13:15:00.000Z','operator','Caixa teste','total',14.94,
        'items', jsonb_build_array(
          jsonb_build_object('code','7891991010029','name','Água Mineral 500ml','price',2.49,'qty',6)),
        'payment', jsonb_build_object('method','cartao','received',14.94,'change',0,'cardType','debito')))
  on conflict (store_id, id) do nothing;

  -- ---------------------------------------------------------------
  -- Caixa: abertura, reforço/sangria e fechamento dos últimos 5 dias
  -- (dia de hoje fica sem abertura — abra ao vivo na apresentação).
  -- ---------------------------------------------------------------
  insert into public.cash_events (store_id, id, at, type, data) values
    -- 03/07 — bate certinho
    (v_store_id, 'seed-cash-0001', '2026-07-03 08:30:00-03', 'open',  jsonb_build_object('operator','Caixa teste','openingFloat',50.00)),
    (v_store_id, 'seed-cash-0002', '2026-07-03 19:30:00-03', 'close', jsonb_build_object('counted',68.97,'expected',68.97,'diff',0,'salesTotal',76.84,'salesCount',3)),
    -- 04/07 — sangria (depósito no cofre) no meio do dia
    (v_store_id, 'seed-cash-0003', '2026-07-04 08:25:00-03', 'open',  jsonb_build_object('operator','Caixa teste','openingFloat',60.00)),
    (v_store_id, 'seed-cash-0004', '2026-07-04 17:00:00-03', 'sangria', jsonb_build_object('amount',40.00)),
    (v_store_id, 'seed-cash-0005', '2026-07-04 19:45:00-03', 'close', jsonb_build_object('counted',68.41,'expected',68.41,'diff',0,'salesTotal',91.25,'salesCount',4)),
    -- 05/07 — reforço de troco à tarde
    (v_store_id, 'seed-cash-0006', '2026-07-05 09:00:00-03', 'open',  jsonb_build_object('operator','Caixa 2 teste','openingFloat',40.00)),
    (v_store_id, 'seed-cash-0007', '2026-07-05 12:00:00-03', 'reforco', jsonb_build_object('amount',20.00)),
    (v_store_id, 'seed-cash-0008', '2026-07-05 18:00:00-03', 'close', jsonb_build_object('counted',76.75,'expected',76.75,'diff',0,'salesTotal',35.22,'salesCount',2)),
    -- 06/07 — fechou com falta de R$ 2,50 (bom exemplo do alerta de diferença)
    (v_store_id, 'seed-cash-0009', '2026-07-06 08:20:00-03', 'open',  jsonb_build_object('operator','Caixa teste','openingFloat',50.00)),
    (v_store_id, 'seed-cash-0010', '2026-07-06 19:20:00-03', 'close', jsonb_build_object('counted',63.97,'expected',66.47,'diff',-2.50,'salesTotal',61.74,'salesCount',3)),
    -- 07/07 — sangria e fechou com sobra de R$ 1,20
    (v_store_id, 'seed-cash-0011', '2026-07-07 08:15:00-03', 'open',  jsonb_build_object('operator','Caixa teste','openingFloat',50.00)),
    (v_store_id, 'seed-cash-0012', '2026-07-07 15:00:00-03', 'sangria', jsonb_build_object('amount',10.00)),
    (v_store_id, 'seed-cash-0013', '2026-07-07 20:00:00-03', 'close', jsonb_build_object('counted',62.39,'expected',61.19,'diff',1.20,'salesTotal',79.04,'salesCount',3))
  on conflict (store_id, id) do nothing;

  raise notice 'Dados de demonstração aplicados na empresa "%": 20 produtos, 1 operador novo (emptcaixa2 / senha 1234), 18 vendas e 5 dias de caixa fechado (hoje fica em aberto para você abrir ao vivo).', v_store_name;
end $$;
