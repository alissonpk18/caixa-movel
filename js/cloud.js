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
   Conflitos: última escrita vence; vendas são append-only (upsert
   idempotente), o caso mais comum de concorrência entre caixas.
   ================================================================ */
const CLOUD_LIB_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js";
const CLOUD_PULL_MS = 60000;

let sbClient = null;        // cliente Supabase (null = lib não carregada/sem config)
let cloudStoreId = null;    // id da empresa vinculada a este aparelho (null = ainda não vinculado)
let cloudApplying = false;  // aplicando um pull: não re-marcar como sujo
const cloudDirty = { products:false, sales:false, users:false, cash:false, settings:false };
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
    cloudStoreId = data[0].store_id;
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
  for(const k of ["users","cash","settings"]){
    if(cloudDirty[k]){ await cloudPushKV(k); cloudDirty[k]=false; }
  }
}

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

async function cloudPushSales(){
  // incremental: só vendas desde o último push (com 1h de sobreposição;
  // o upsert é idempotente, reenvio repetido não duplica)
  const mark = await sget("pdv:cloudSalesMark");
  const cut = mark ? new Date(new Date(mark).getTime()-3600000).toISOString() : "";
  const list = cut ? DB.sales.filter(s=>s.ts>=cut) : DB.sales;
  const rows = list.map(s=>({
    store_id:cloudStoreId, id:s.id, at:s.ts, total:s.total,
    operator:s.operator||"", method:(s.payment&&s.payment.method)||"", data:s
  }));
  if(rows.length){
    const { error } = await sbClient.from("sales").upsert(rows);
    if(error) throw error;
  }
  await sset("pdv:cloudSalesMark", new Date().toISOString());
}

async function cloudPushKV(key){
  const value = key==="users" ? DB.users : key==="cash" ? DB.cash : settings;
  const { error } = await sbClient.from("kv").upsert({ store_id:cloudStoreId, key, value });
  if(error) throw error;
}

/* ---------- pull (nuvem → local) ---------- */
async function cloudPull(){
  if(!cloudOn() || !navigator.onLine) return;
  const [pr, sl, kv] = await Promise.all([
    sbClient.from("products").select("code,name,price,cost,qty,exp").eq("store_id",cloudStoreId),
    sbClient.from("sales").select("data").eq("store_id",cloudStoreId).order("at",{ascending:false}).limit(5000),
    sbClient.from("kv").select("key,value").eq("store_id",cloudStoreId)
  ]);
  const err = pr.error || sl.error || kv.error;
  if(err) throw err;

  const kvMap = {};
  (kv.data||[]).forEach(r=>{ kvMap[r.key]=r.value; });

  cloudApplying = true;
  try{
    DB.products = sanitizeProducts((pr.data||[]).map(p=>({
      code:p.code, name:p.name, price:Number(p.price),
      cost:(p.cost==null?undefined:Number(p.cost)), qty:p.qty, exp:p.exp||null
    })));
    DB.sales = sanitizeSales((sl.data||[]).map(r=>r.data));
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
