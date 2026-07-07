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

   Conflitos — kv (usuários/caixa/config) e metadados de produto (nome/
   preço/custo/validade) seguem "última escrita vence": simples, e uma
   segunda gerência mexendo ao mesmo tempo é raro. Já a QUANTIDADE em
   estoque nunca é sincronizada por valor absoluto — duas vendas ou
   reposições simultâneas em aparelhos diferentes fariam uma delas
   "vencer" e a outra baixa sumir. Em vez disso, toda mudança de
   quantidade vira uma fila local de operações (venda, ajuste relativo,
   correção absoluta) aplicada no banco por RPCs atômicas — o banco quem
   soma/subtrai, nunca o cliente que "define" o número final. */
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
const cloudDirty = { products:false, sales:false, stock:false, users:false, cash:false, settings:false };
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
  if(cloudDirty.products){ await cloudPushProducts(); cloudDirty.products=false; }
  if(cloudDirty.sales){    await cloudPushSales();    cloudDirty.sales=false; }
  if(cloudDirty.stock){    await cloudPushStock();    cloudDirty.stock=false; }
  for(const k of ["users","cash","settings"]){
    if(cloudDirty[k]){ await cloudPushKV(k); cloudDirty[k]=false; }
  }
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
  const value = key==="users" ? DB.users : key==="cash" ? DB.cash : settings;
  const { error } = await sbClient.from("kv").upsert({ store_id:cloudStoreId, key, value });
  if(error) throw error;
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

  const [pr, sl, kv] = await Promise.all([
    sbClient.from("products").select("code,name,price,cost,qty,exp").eq("store_id",cloudStoreId),
    salesQuery,
    sbClient.from("kv").select("key,value").eq("store_id",cloudStoreId)
  ]);
  const err = pr.error || sl.error || kv.error;
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

    if(kvMap.users)    DB.users = sanitizeUsers(kvMap.users);
    if(kvMap.cash)     DB.cash  = sanitizeCash(kvMap.cash) || DB.cash;
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
