"use strict";
/* ================================================================
   NUVEM (modo SaaS) — sincronização opcional via Supabase.

   Sem js/config.js preenchido o app roda 100% local; nada aqui executa.

   Modelo v1: uma conta Supabase = uma loja. Todos os aparelhos da loja
   entram com a mesma conta; os logins de operador (gerente/caixa)
   continuam locais e são sincronizados como dados da loja (kv).

   Estratégia: offline-first. O app opera sempre sobre o storage local;
   esta camada empurra mudanças (push, com debounce) e puxa o estado da
   nuvem (pull) ao abrir, ao voltar ao primeiro plano e a cada minuto.
   Conflitos: última escrita vence; vendas são append-only (upsert
   idempotente), o caso mais comum de concorrência entre caixas.
   ================================================================ */
const CLOUD_LIB_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js";
const CLOUD_PULL_MS = 60000;

let sbClient = null;        // cliente Supabase (null = lib não carregada/sem config)
let cloudStoreId = null;    // id da loja na nuvem (null = sem sessão)
let cloudUserEmail = "";
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

/* chamado pelo boot(); nunca bloqueia a abertura do app */
async function cloudInit(){
  if(!cloudEnabled()) return;
  wireCloudBox();
  try{
    await cloudLoadLib();
    sbClient = window.supabase.createClient(CLOUD_CONFIG.url, CLOUD_CONFIG.anonKey);
    const { data } = await sbClient.auth.getSession();
    if(data && data.session){
      cloudUserEmail = (data.session.user && data.session.user.email) || "";
      await cloudEnsureStore();
      await cloudSync();
      cloudStartLoops();
    }
  }catch(e){ /* sem rede ou nuvem fora do ar: segue 100% local */ }
  renderCloudBox();
}

/* garante a linha da loja desta conta (primeiro acesso cria) */
async function cloudEnsureStore(){
  let { data, error } = await sbClient.from("stores").select("id").maybeSingle();
  if(error) throw error;
  if(!data){
    const r = await sbClient.from("stores").insert({ name:"Minha loja", email:cloudUserEmail }).select("id").single();
    if(r.error) throw r.error;
    data = r.data;
  }
  cloudStoreId = data.id;
}

/* ---------- push (local → nuvem) ---------- */
/* chamado pelos save* do store.js; agrupa mudanças num único envio */
function cloudMarkDirty(kind){
  if(!cloudEnabled() || cloudApplying) return;
  if(kind in cloudDirty) cloudDirty[kind]=true;
  if(!cloudOn()) return;               // sem sessão: fica pendente para o próximo sync
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
  const cloudEmpty = !(pr.data||[]).length && !(sl.data||[]).length && !kvMap.users;
  if(cloudEmpty){
    // loja recém-criada: em vez de zerar o aparelho, sobe o que há nele
    Object.keys(cloudDirty).forEach(k=>{ cloudDirty[k]=true; });
    await sset("pdv:cloudSalesMark", null);
    await cloudPush();
    return;
  }

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

/* sincronização: no primeiro contato deste aparelho com esta loja a
   nuvem manda (descarta pendências locais — que podem ser só o seed de
   fábrica); depois de vinculado, é push das pendências e pull. */
async function cloudSync(){
  const bound = await sget("pdv:cloudBound");
  if(bound === cloudStoreId){
    try{ await cloudPush(); }catch(e){}
    await cloudPull();
  }else{
    Object.keys(cloudDirty).forEach(k=>{ cloudDirty[k]=false; });
    await cloudPull();          // nuvem vazia? o pull semeia a partir do local
    await sset("pdv:cloudBound", cloudStoreId);
  }
}

function cloudStartLoops(){
  if(cloudStartLoops.done) return;
  cloudStartLoops.done = true;
  window.addEventListener("online", ()=>{ cloudSync().catch(()=>{}); });
  document.addEventListener("visibilitychange", ()=>{ if(!document.hidden) cloudSync().catch(()=>{}); });
  setInterval(()=>{ if(!document.hidden) cloudSync().catch(()=>{}); }, CLOUD_PULL_MS);
}

/* re-renderiza o que estiver na tela após um pull */
function cloudRefreshUI(){
  try{
    if(state.user && state.user.role==="gerente" && $("gerente").classList.contains("is-active")) renderManager();
    if(state.user && state.user.role==="operador") renderCart();
  }catch(e){}
}

/* ---------- conta da loja (UI na tela de login) ---------- */
function wireCloudBox(){
  const box=$("cloudBox");
  if(!box || wireCloudBox.done) return;
  wireCloudBox.done=true;
  box.style.display="";
  $("cloudLoginBtn").addEventListener("click", ()=>cloudAuth(false));
  $("cloudSignupBtn").addEventListener("click", ()=>cloudAuth(true));
  $("cloudLogoutBtn").addEventListener("click", cloudLogoutStore);
}

async function cloudAuth(isSignup){
  if(cloudAuth.busy) return;
  cloudAuth.busy=true;
  try{
    const errEl=$("cloudErr");
    if(!sbClient){ errEl.textContent="Nuvem indisponível agora — verifique a internet e recarregue."; return; }
    const email=$("cloudEmail").value.trim(), pass=$("cloudPass").value;
    if(!email || pass.length<6){ errEl.textContent="Informe o e-mail e uma senha com 6+ caracteres."; return; }
    errEl.textContent="";
    if(isSignup){
      const { data, error } = await sbClient.auth.signUp({ email, password:pass });
      if(error){ errEl.textContent=cloudErrMsg(error); return; }
      if(!data || !data.session){
        errEl.textContent="Conta criada! Confirme o e-mail que enviamos e toque em Entrar.";
        return;
      }
    }else{
      const { error } = await sbClient.auth.signInWithPassword({ email, password:pass });
      if(error){ errEl.textContent=cloudErrMsg(error); return; }
    }
    const { data:s } = await sbClient.auth.getSession();
    cloudUserEmail = (s && s.session && s.session.user && s.session.user.email) || email;
    await cloudEnsureStore();
    await cloudSync();
    cloudStartLoops();
    $("cloudPass").value="";
    renderCloudBox();
    toast("✓ Loja conectada — dados sincronizados","ok");
  }catch(e){
    $("cloudErr").textContent=cloudErrMsg(e);
  }finally{ cloudAuth.busy=false; }
}

function cloudErrMsg(e){
  const m=String((e && e.message) || e || "");
  if(/invalid login/i.test(m))      return "E-mail ou senha incorretos.";
  if(/already registered/i.test(m)) return "Este e-mail já tem conta — use Entrar.";
  if(/not confirmed/i.test(m))      return "Confirme o e-mail antes de entrar.";
  if(/fetch|network/i.test(m))      return "Sem conexão com a nuvem — tente de novo.";
  return "Não deu certo: "+m;
}

async function cloudLogoutStore(){
  try{ await sbClient.auth.signOut(); }catch(e){}
  cloudStoreId=null; cloudUserEmail="";
  renderCloudBox();
  toast("Loja desconectada da nuvem","");
}

function renderCloudBox(){
  const box=$("cloudBox");
  if(!box || !cloudEnabled()) return;
  const on=cloudOn();
  $("cloudForm").style.display  = on ? "none" : "";
  $("cloudStatus").style.display= on ? "" : "none";
  if(on) $("cloudWho").textContent="✓ Loja conectada: "+cloudUserEmail;
}
