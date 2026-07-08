"use strict";
/* ================================================================
   NUVEM (modo SaaS) — sincronização opcional via Supabase.

   Sem js/config.js preenchido o app roda 100% local; nada aqui executa.

   Modelo: a plataforma (você) cria a empresa e cadastra gerente/caixa
   pelo admin.html. O aparelho do lojista NÃO tem nenhuma tela extra de
   "conectar à nuvem" — é só o login de sempre (usuário/senha). Se o
   usuário digitado não existe neste aparelho, a nuvem é consultada
   (RPC login_operator, que roda no banco e confere a senha com o mesmo
   hash SHA-256 já usado localmente); se bater, o aparelho se vincula
   automaticamente àquela empresa e baixa os dados dela. Da próxima vez
   o login já resolve local, sem round-trip.

   O vínculo aparelho↔empresa usa uma sessão anônima do Supabase Auth
   (grátis, sem e-mail) só para o RLS saber "este aparelho pertence à
   empresa X" — habilite Authentication → Anonymous Sign-Ins no projeto.

   Estratégia: offline-first. O app opera sempre sobre o storage local;
   esta camada empurra mudanças (push, com debounce) e puxa o estado da
   nuvem (pull) ao abrir, ao voltar ao primeiro plano e a cada minuto.

   Conflitos — kv de configuração e metadados de produto (nome/preço/
   custo/validade) seguem "última escrita vence": simples, e uma segunda
   gerência mexendo ao mesmo tempo é raro. Três coisas NÃO podem ser
   assim, porque dois aparelhos mexendo nelas ao mesmo tempo é comum e
   uma "vencer" apaga silenciosamente o que o outro fez:
   - QUANTIDADE em estoque: nunca sincronizada por valor absoluto — toda
     mudança vira uma fila de operações (venda, ajuste relativo,
     correção absoluta) aplicada por RPCs atômicas no banco.
   - VENDAS: sempre foram append-only (upsert idempotente por id).
   - CAIXA (abertura/sangria/reforço/fechamento): também append-only —
     cada ação é um evento próprio, e o estado é reconstruído
     reproduzindo os eventos em ordem (nunca mais um documento único). */
/* versão pinada (não "@2" flutuante) + verificação de integridade (SRI):
   um CDN comprometido não pode trocar silenciosamente o código que fala
   com a nuvem de todas as empresas. Ao atualizar a versão, recalcule o
   hash: curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A */
const CLOUD_LIB_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
const CLOUD_LIB_SRI = "sha384-GFr3yTh5lJznCbZfpTtXnwboFsxqtTQoeTZCRHhE0579KrRmlCzen5AA8ohaB5ug";
const CLOUD_PULL_MS = 60000;

let sbClient = null;        // cliente Supabase (null = lib não carregada/sem config)
let cloudStoreId = null;    // id da empresa vinculada a este aparelho (null = ainda não vinculado)
let cloudApplying = false;  // aplicando um pull: não re-marcar como sujo
/* "users" não entra na fila de dirty/push — a escrita em `operators` é
   sempre síncrona e imediata via RPC (cloudCreateCashier/cloudSetCashierStock/
   cloudDeleteCashier, logo abaixo): admin.html grava direto na tabela, e
   agora o gerente também escreve, mas só nos CAIXAS da própria empresa
   (manager_* em supabase/schema.sql). O aparelho sempre LÊ o resultado
   pelo pull normal — nunca "empurra" o array DB.users inteiro. */
const cloudDirty = { products:false, sales:false, stock:false, cashEvents:false, settings:false };
let cloudPushT = null;

function cloudEnabled(){
  return typeof CLOUD_CONFIG !== "undefined" && !!(CLOUD_CONFIG && CLOUD_CONFIG.url && CLOUD_CONFIG.anonKey);
}
function cloudOn(){ return !!(sbClient && cloudStoreId); }

/* carrega a lib só quando a nuvem está configurada (não pesa o modo local) */
function cloudLoadLib(){
  return new Promise((resolve, reject)=>{
    if(window.supabase && window.supabase.createClient) return resolve();
    const s=document.createElement("script");
    s.src=CLOUD_LIB_URL; s.async=true;
    s.integrity=CLOUD_LIB_SRI; s.crossOrigin="anonymous"; s.referrerPolicy="no-referrer";
    s.onload=()=>resolve();
    s.onerror=()=>reject(new Error("biblioteca da nuvem não carregou"));
    document.head.appendChild(s);
  });
}

/* chamado pelo boot(); nunca bloqueia a abertura do app. Garante uma
   sessão anônima (identidade do aparelho perante o RLS) e, se este
   aparelho já estiver vinculado a uma empresa de uma sessão anterior,
   retoma a sincronização sem precisar logar de novo. */
async function cloudInit(){
  if(!cloudEnabled()) return;
  try{
    await cloudLoadLib();
    sbClient = window.supabase.createClient(CLOUD_CONFIG.url, CLOUD_CONFIG.anonKey);
    const { data } = await sbClient.auth.getSession();
    if(!data || !data.session){
      const r = await sbClient.auth.signInAnonymously();
      if(r.error) throw r.error;
    }
    const { data:dl, error } = await sbClient.from("device_links").select("store_id").maybeSingle();
    if(!error && dl && dl.store_id){
      cloudStoreId = dl.store_id;
      await cloudPull();
      cloudStartLoops();
    }
  }catch(e){ /* sem rede, nuvem fora do ar, ou sign-in anônimo desabilitado: segue local */ }
}

/* chamado pelo login() quando o usuário não existe neste aparelho.
   Pergunta à nuvem "de qual empresa é este usuário?", com a senha
   conferida no banco (mesmo hash SHA-256 do modo local). Se bater,
   vincula o aparelho e baixa os dados da empresa. */
async function cloudRouteLogin(username, plainPassword){
  if(!cloudEnabled() || !sbClient) return false;
  try{
    const hash = await hashPassword(plainPassword);
    if(!hash) return false;
    const { data, error } = await sbClient.rpc("login_operator", { p_username:username, p_hash:hash });
    if(error || !data || !data.length) return false;
    const newStoreId = data[0].store_id;
    /* aparelho usado antes por OUTRA empresa (raro — reaproveitado,
       revogado e realugado etc.): zera o cache local antes de puxar,
       senão o merge incremental de vendas (cloudPull) misturaria
       vendas de duas empresas diferentes no mesmo aparelho */
    const prevStoreId = await sget("pdv:cloudLastStoreId");
    if(prevStoreId && prevStoreId !== newStoreId){
      DB.products=[]; DB.sales=[]; DB.users=[]; DB.cash={ open:null, history:[] };
      await sset("pdv:cloudSalesPullMark:"+prevStoreId, null);
    }
    cloudStoreId = newStoreId;
    await sset("pdv:cloudLastStoreId", newStoreId);
    await cloudPull();
    cloudStartLoops();
    return true;
  }catch(e){ return false; }
}

/* ---------- operadores: gerente cadastra/gerencia os CAIXAS da própria
   empresa (js/users.js) ---------- */
/* diferente do resto da sincronização (fila + debounce), estas chamadas
   são síncronas: a tela só reflete "cadastrado"/"removido" depois que o
   banco confirma, porque o RPC pode recusar (regra de negócio ou de
   RLS) e não faria sentido mostrar algo que a nuvem não aceitou. O
   store_id nunca é enviado — quem resolve a empresa é a RPC
   manager_create_cashier (schema.sql), a partir de quem está logado
   neste aparelho; é assim que o caixa herda a empresa automaticamente. */
async function cloudCreateCashier(username, name, passHash, canAddStock){
  if(!cloudOn()) return { ok:false, error:"offline" };
  const { error } = await sbClient.rpc("manager_create_cashier", {
    p_username: username, p_name: name, p_pass_hash: passHash, p_can_add_stock: !!canAddStock
  });
  return error ? { ok:false, error: error.message||String(error) } : { ok:true };
}
async function cloudSetCashierStock(username, allow){
  if(!cloudOn()) return { ok:false, error:"offline" };
  const { error } = await sbClient.rpc("manager_set_cashier_stock", { p_username: username, p_allow: !!allow });
  return error ? { ok:false, error: error.message||String(error) } : { ok:true };
}
async function cloudDeleteCashier(username){
  if(!cloudOn()) return { ok:false, error:"offline" };
  const { error } = await sbClient.rpc("manager_delete_cashier", { p_username: username });
  return error ? { ok:false, error: error.message||String(error) } : { ok:true };
}

/* ---------- push (local → nuvem) ---------- */
/* chamado pelos save* do store.js; agrupa mudanças num único envio */
function cloudMarkDirty(kind){
  if(!cloudEnabled() || cloudApplying) return;
  if(kind in cloudDirty) cloudDirty[kind]=true;
  if(!cloudOn()) return;               // ainda não vinculado: fica pendente
  clearTimeout(cloudPushT);
  cloudPushT=setTimeout(()=>{ cloudPush().catch(()=>{}); }, 1500);
}

async function cloudPush(){
  if(!cloudOn() || !navigator.onLine) return;
  if(cloudDirty.products){   await cloudPushProducts();   cloudDirty.products=false; }
  if(cloudDirty.sales){      await cloudPushSales();       cloudDirty.sales=false; }
  if(cloudDirty.stock){      await cloudPushStock();       cloudDirty.stock=false; }
  if(cloudDirty.cashEvents){ await cloudPushCashEvents();  cloudDirty.cashEvents=false; }
  if(cloudDirty.settings){   await cloudPushKV("settings"); cloudDirty.settings=false; }
}

/* metadados (nome/preço/custo/validade) + inserção de produto novo.
   qty vai junto por simplicidade, mas o banco ignora esse campo num
   UPDATE (gatilho products_protect_qty) — só entra de fato num INSERT
   (produto que ainda não existia na nuvem). Mudar a quantidade de um
   produto já existente é sempre via fila (venda/ajuste/correção). */
async function cloudPushProducts(){
  const rows = DB.products.map(p=>({
    store_id:cloudStoreId, code:String(p.code), name:p.name,
    price:p.price, cost:(p.cost==null?null:p.cost), qty:p.qty, exp:p.exp||null
  }));
  if(rows.length){
    const { error } = await sbClient.from("products").upsert(rows);
    if(error) throw error;
  }
  // remove da nuvem o que foi excluído localmente
  let del = sbClient.from("products").delete().eq("store_id", cloudStoreId);
  if(rows.length){
    const codes = rows.map(r=>'"'+r.code.replace(/["\\,()]/g,"")+'"').join(",");
    del = del.not("code","in","("+codes+")");
  }
  const { error } = await del;
  if(error) throw error;
}

/* fila explícita (achado A-07): cada venda finalizada entra numa lista
   persistida e só sai dela quando o servidor confirma a RPC apply_sale
   (idempotente — reenviar não duplica nem debita de novo). Substitui a
   antiga janela "desde a última vez, com 1h de sobreposição", que
   dependia do relógio do aparelho e podia deixar vendas para trás. */
async function cloudPushSales(){
  const pending = (await sget("pdv:cloudPendingSales")) || [];
  for(let i=0;i<pending.length;i++){
    const sale = DB.sales.find(s=>s.id===pending[i]);
    if(!sale) continue; // nada a enviar (não deveria acontecer)
    const { error } = await sbClient.rpc("apply_sale", { p_sale: sale });
    if(error){ await sset("pdv:cloudPendingSales", pending.slice(i)); throw error; }
  }
  await sset("pdv:cloudPendingSales", []);
}

/* fila de ajustes de estoque (achado A-02): ajustes relativos primeiro
   (reposição — soma), depois correções absolutas (edição manual da
   gerência / restauração de backup — define). Cada RPC é atômica no
   banco; em caso de erro, preserva só o que ainda não foi aplicado. */
async function cloudPushStock(){
  const deltas = (await sget("pdv:cloudPendingStockDeltas")) || [];
  for(let i=0;i<deltas.length;i++){
    const { code, delta } = deltas[i];
    const { error } = await sbClient.rpc("adjust_stock", { p_code:code, p_delta:delta });
    if(error){ await sset("pdv:cloudPendingStockDeltas", deltas.slice(i)); throw error; }
  }
  await sset("pdv:cloudPendingStockDeltas", []);

  const sets = (await sget("pdv:cloudPendingStockSets")) || {};
  for(const code of Object.keys(sets)){
    const { error } = await sbClient.rpc("set_stock", { p_code:code, p_qty:sets[code] });
    if(error){ await sset("pdv:cloudPendingStockSets", sets); throw error; }
    delete sets[code];
  }
  await sset("pdv:cloudPendingStockSets", sets); // {} se tudo foi aplicado
}

/* chamado por js/sale.js ao finalizar uma venda. */
async function cloudEnqueueSale(id){
  if(!cloudEnabled()) return;
  try{
    const list = (await sget("pdv:cloudPendingSales")) || [];
    if(!list.includes(id)){ list.push(id); await sset("pdv:cloudPendingSales", list); }
  }catch(e){}
  cloudMarkDirty("sales");
}
/* chamado por js/cashbox.js ao confirmar uma reposição (+Estoque). */
async function cloudEnqueueStockDelta(code, delta){
  if(!cloudEnabled() || !delta) return;
  try{
    const list = (await sget("pdv:cloudPendingStockDeltas")) || [];
    list.push({ code:String(code), delta });
    await sset("pdv:cloudPendingStockDeltas", list);
  }catch(e){}
  cloudMarkDirty("stock");
}
/* chamado por js/main.js (edição manual da quantidade pela gerência) e
   por js/backup.js (restauração de backup) — "definir", não "somar". */
async function cloudEnqueueStockSet(code, qty){
  if(!cloudEnabled()) return;
  try{
    const map = (await sget("pdv:cloudPendingStockSets")) || {};
    map[String(code)] = qty;
    await sset("pdv:cloudPendingStockSets", map);
  }catch(e){}
  cloudMarkDirty("stock");
}

async function cloudPushKV(key){
  const { error } = await sbClient.from("kv").upsert({ store_id:cloudStoreId, key, value:settings });
  if(error) throw error;
}

/* fila de eventos de caixa (achado A-06): abertura, sangria, reforço e
   fechamento entram como eventos independentes — nunca mais um upsert
   do documento inteiro, que apagava o movimento feito por outro
   aparelho enquanto este estava sem sincronizar. */
async function cloudEnqueueCashEvent(type, data){
  if(!cloudEnabled()) return;
  try{
    const list = (await sget("pdv:cloudPendingCashEvents")) || [];
    list.push({ id:uid(), at:new Date().toISOString(), type, data });
    await sset("pdv:cloudPendingCashEvents", list);
  }catch(e){}
  cloudMarkDirty("cashEvents");
}
async function cloudPushCashEvents(){
  const pending = (await sget("pdv:cloudPendingCashEvents")) || [];
  if(!pending.length) return;
  const rows = pending.map(e=>({ store_id:cloudStoreId, id:e.id, at:e.at, type:e.type, data:e.data }));
  const { error } = await sbClient.from("cash_events").upsert(rows);
  if(error) throw error;
  await sset("pdv:cloudPendingCashEvents", []);
}

/* reconstrói {open, history} reproduzindo os eventos em ordem — mesmo
   formato que js/cashbox.js sempre usou, só a origem dos dados muda */
function reconstructCash(events){
  let open = null;
  const history = [];
  events.forEach(e=>{
    const d = e.data || {};
    if(e.type==="open"){
      open = { openedAt:e.at, operator:d.operator||"—", openingFloat:Number(d.openingFloat)||0, movements:[] };
    }else if((e.type==="sangria" || e.type==="reforco") && open){
      open.movements.push({ type:e.type, amount:Number(d.amount)||0, ts:e.at });
    }else if(e.type==="close" && open){
      history.unshift({ ...open, closedAt:e.at, expected:Number(d.expected)||0, counted:Number(d.counted)||0,
        diff:Number(d.diff)||0, salesTotal:Number(d.salesTotal)||0, salesCount:Number(d.salesCount)||0 });
      open = null;
    }
  });
  return { open, history: history.slice(0,60) };
}

/* o admin pode revogar o vínculo deste aparelho a qualquer momento
   (tabela device_links). Sem essa checagem, a próxima sincronização
   receberia tudo vazio (o RLS simplesmente para de liberar as linhas da
   empresa) e o app apagaria os dados locais como se a empresa não
   tivesse nada — em vez disso, detectamos a revogação e saímos para o
   login com aviso, preservando o storage local intacto. */
async function cloudStillLinked(){
  const { data, error } = await sbClient.from("device_links").select("store_id").maybeSingle();
  if(error) return true; // falha de rede/nuvem: não pune, tenta de novo no próximo ciclo
  return !!(data && data.store_id === cloudStoreId);
}
function cloudHandleRevoked(){
  cloudStoreId = null;
  try{
    if(state.user){ logout(); toast("Este aparelho foi desconectado da loja pela gerência.","bad"); }
  }catch(e){}
}

/* ---------- pull (nuvem → local) ----------
   Produtos e kv continuam vindo por inteiro a cada pull — catálogos e
   documentos pequenos, e enxergar o conjunto todo é o jeito mais simples
   de refletir exclusões feitas em outro aparelho. Vendas são a parte que
   cresce sem limite com o tempo (era o "megabytes por minuto" do achado
   A-05): agora são incrementais — só as mais novas que a última recebida
   por ESTA empresa, mescladas ao que o aparelho já tinha (nunca
   substituídas). Histórico muito antigo, além do que já foi baixado uma
   vez, fica só no servidor — relatórios de período longo buscam sob
   demanda quando precisarem, não a cada sincronização de rotina. */
async function cloudPull(){
  if(!cloudOn() || !navigator.onLine) return;
  if(!(await cloudStillLinked())){ cloudHandleRevoked(); return; }

  const markKey = "pdv:cloudSalesPullMark:"+cloudStoreId;
  const mark = await sget(markKey);
  const base = sbClient.from("sales").select("data,at").eq("store_id",cloudStoreId).limit(5000);
  const salesQuery = mark
    ? base.gt("at", mark).order("at",{ascending:true})   // backlog novo: mais antigo primeiro
    : base.order("at",{ascending:false});                 // primeira vez: as 5000 mais recentes

  const [pr, sl, kv, ops, ce] = await Promise.all([
    sbClient.from("products").select("code,name,price,cost,qty,exp").eq("store_id",cloudStoreId),
    salesQuery,
    sbClient.from("kv").select("key,value").eq("store_id",cloudStoreId),
    sbClient.from("operators").select("username,name,role,can_add_stock,pass_hash").eq("store_id",cloudStoreId),
    sbClient.from("cash_events").select("type,at,data").eq("store_id",cloudStoreId)
  ]);
  const err = pr.error || sl.error || kv.error || ops.error || ce.error;
  if(err) throw err;

  const kvMap = {};
  (kv.data||[]).forEach(r=>{ kvMap[r.key]=r.value; });
  const salesRows = (sl.data||[]).slice().sort((a,b)=> a.at.localeCompare(b.at));

  cloudApplying = true;
  try{
    DB.products = sanitizeProducts((pr.data||[]).map(p=>({
      code:p.code, name:p.name, price:Number(p.price),
      cost:(p.cost==null?undefined:Number(p.cost)), qty:p.qty, exp:p.exp||null
    })));

    const incoming = sanitizeSales(salesRows.map(r=>r.data)) || [];
    if(incoming.length){
      const known = new Set(DB.sales.map(s=>s.id));
      incoming.forEach(s=>{ if(!known.has(s.id)){ DB.sales.push(s); known.add(s.id); } });
      DB.sales.sort((a,b)=> b.ts.localeCompare(a.ts)); // mais recente primeiro (ordem que a UI espera)
      await sset(markKey, salesRows[salesRows.length-1].at);
    }

    // usuários (gerente/caixa) vêm da tabela operators (achado A-03),
    // gerenciada só pelo console admin — nunca de kv
    DB.users = sanitizeUsers((ops.data||[]).map(o=>({
      username:o.username, name:o.name, role:o.role, canAddStock:o.can_add_stock, passHash:o.pass_hash
    })));

    // caixa (achado A-06): reconstrói reproduzindo os eventos em ordem.
    // kv.cash só é lido como ponte de migração — enquanto nenhum evento
    // ainda existe (loja que abriu caixa antes desta mudança), evita
    // "esquecer" uma sessão aberta; assim que o próximo evento acontecer
    // (sangria, reforço, fechamento), os eventos passam a mandar.
    const cashEvents = (ce.data||[]).slice().sort((a,b)=> a.at.localeCompare(b.at));
    if(cashEvents.length) DB.cash = reconstructCash(cashEvents);
    else if(kvMap.cash)   DB.cash = sanitizeCash(kvMap.cash) || DB.cash;

    if(kvMap.settings) applySettings(kvMap.settings);
    ensureManagerAccess();
    await saveProducts(); await saveSales(); await saveUsers(); await saveCash(); await saveSettings();
  }finally{ cloudApplying = false; }
  cloudRefreshUI();
}

function cloudStartLoops(){
  if(cloudStartLoops.done) return;
  cloudStartLoops.done = true;
  window.addEventListener("online", ()=>{ cloudSync().catch(()=>{}); });
  document.addEventListener("visibilitychange", ()=>{ if(!document.hidden) cloudSync().catch(()=>{}); });
  setInterval(()=>{ if(!document.hidden) cloudSync().catch(()=>{}); }, CLOUD_PULL_MS);
}

async function cloudSync(){
  if(cloudOn() && navigator.onLine && !(await cloudStillLinked())){ cloudHandleRevoked(); return; }
  try{ await cloudPush(); }catch(e){}
  try{ await cloudPull(); }catch(e){}
}

/* re-renderiza o que estiver na tela após um pull */
function cloudRefreshUI(){
  try{
    if(state.user && state.user.role==="gerente" && $("gerente").classList.contains("is-active")) renderManager();
    if(state.user && state.user.role==="operador") renderCart();
  }catch(e){}
}
