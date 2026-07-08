"use strict";
/* ---------- camada de dados ----------
   Persistência em camadas: 1) window.storage (artifact) →
   2) localStorage (navegador) → 3) memória (só nesta sessão, com aviso). */
const hasArtifactStorage = typeof window.storage !== "undefined" && window.storage && typeof window.storage.get === "function";
let hasLocalStorage = false;
try{ const k="__pdv_test__"; window.localStorage.setItem(k,"1"); window.localStorage.removeItem(k); hasLocalStorage=true; }catch(e){ hasLocalStorage=false; }
let storageOK = hasArtifactStorage || hasLocalStorage;

const DB = { users:[], products:[], sales:[], cash:{ open:null, history:[] } };
let settings = { lowStock:5, expWarnDays:30, pixKey:"", pixName:"", pixCity:"" };
let salesFilter = todayKey();   // chave de data selecionada; null = todas
let prodQuery = "";
let state = { user:null, cart:[], muted:false, scanner:null, native:null, scanReady:false, scanStarting:false, scanStopping:null, lastScan:{code:"",t:0}, audio:null, pay:{method:"dinheiro"}, lastSale:null };

/* administrador global da plataforma: único papel sem vínculo de empresa (empresa:null),
   responsável por criar/editar/gerenciar o acesso das contas de gerência */
const SEED_ADMIN = { username:"alissonpk18@gmail.com", password:"Ali@8865", role:"admin", name:"Administrador Global", empresa:null };
const SEED_USERS = [
  { username:"gerente", password:"1234", role:"gerente",  name:"Gerência", canAddStock:true,  empresa:"Empresa Demo" },
  { username:"caixa",   password:"1234", role:"operador", name:"Caixa 1",  canAddStock:false, empresa:"Empresa Demo" }
];
/* a gerência tem acesso total ao estoque; para operadores a permissão é opcional */
function canAddStock(user){ return !!user && (user.role==="gerente" || user.canAddStock===true); }
/* usuários da mesma empresa (tenant) de um gerente/caixa — isola a listagem/gestão por loja */
function companyUsers(empresa){ return DB.users.filter(u=>u.empresa===empresa); }
const SEED_PRODUCTS = [
  { code:"7891000100103", name:"Leite Integral 1L",     price:5.49,  qty:40, exp:"2026-07-12" },
  { code:"7894900011517", name:"Refrigerante Cola 2L",  price:8.99,  qty:24, exp:"2027-01-15" },
  { code:"7891910000197", name:"Açúcar Refinado 1kg",   price:4.29,  qty:30, exp:"2026-06-20" },
  { code:"7896005800010", name:"Café Torrado 500g",     price:16.90, qty:18, exp:"2026-12-01" },
  { code:"7891000053508", name:"Biscoito Recheado",     price:6.49,  qty:50, exp:"2026-07-28" },
  { code:"7898080640017", name:"Pão de Forma",          price:7.99,  qty:12, exp:"2026-07-04" },
  { code:"7891150064201", name:"Detergente",            price:2.79,  qty:5,  exp:null },
  { code:"7896036090010", name:"Arroz 5kg",             price:24.90, qty:15, exp:"2027-03-10" }
];

async function sget(key){
  try{
    if(hasArtifactStorage){ const r = await window.storage.get(key); return r ? JSON.parse(r.value) : null; }
    if(hasLocalStorage){ const v = window.localStorage.getItem(key); return v ? JSON.parse(v) : null; }
    return null;
  }catch(e){ return null; }
}
async function sset(key,val){
  try{
    if(hasArtifactStorage){ const ok = await window.storage.set(key, JSON.stringify(val)); if(!ok) markStorageFailure(); return !!ok; }
    if(hasLocalStorage){ window.localStorage.setItem(key, JSON.stringify(val)); return true; }
    markStorageFailure(); return false;
  }catch(e){ markStorageFailure(); return false; }
}
/* uma gravação falhou (quota cheia, storage revogado…): avisa na tela em vez de perder dados em silêncio */
function markStorageFailure(){
  storageOK=false;
  const txt = (hasArtifactStorage||hasLocalStorage)
    ? "⚠ Falha ao salvar — os dados podem não persistir neste aparelho"
    : "⚠ Salvando só nesta sessão (armazenamento indisponível)";
  [$("storageBanner"),$("storageBanner2")].forEach(b=>{ if(b){ b.textContent=txt; b.classList.add("show"); } });
}

/* aplica só os campos válidos vindos do storage sobre os padrões atuais */
function applySettings(st){ Object.assign(settings, sanitizeSettings(st)); }
/* garante que sempre exista ao menos um acesso de gerência (evita trancar o app) */
function ensureManagerAccess(){
  if(DB.users.some(u=>u.role==="gerente")) return;
  DB.users.push({...SEED_USERS[0]});
  saveUsers();
}
/* garante que sempre exista ao menos um administrador global (só ele cria/gerencia gerências) */
function ensureAdminAccess(){
  if(DB.users.some(u=>u.role==="admin")) return;
  DB.users.push({...SEED_ADMIN});
  saveUsers();
}
/* cada gravação local também avisa a nuvem (no-op quando não configurada) */
const dirty = (k) => { if(typeof cloudMarkDirty==="function") cloudMarkDirty(k); };
const saveProducts = () => { dirty("products"); return sset("pdv:products", DB.products); };
const saveSales    = () => { dirty("sales");    return sset("pdv:sales", DB.sales); };
const saveUsers    = () => { dirty("users");    return sset("pdv:users", DB.users); };
const saveCash     = () => { dirty("cash");     return sset("pdv:cash", DB.cash); };
const saveSettings = () => { dirty("settings"); return sset("pdv:settings", settings); };
const saveSession  = () => sset("pdv:session", state.user ? {username:state.user.username, role:state.user.role, name:state.user.name} : null);

async function boot(){
  /* com a nuvem configurada, o aparelho não deve nascer com o gerente/caixa
     de demonstração: eles funcionariam localmente (dados vazios, sem
     relação com nenhuma empresa real) e só confundiriam quem tenta entrar
     antes do primeiro login rotear e vincular o aparelho pela nuvem. */
  const cloud = typeof cloudEnabled==="function" && cloudEnabled();
  if(cloud){ const hint=$("loginHint"); if(hint) hint.style.display="none"; }

  if(hasArtifactStorage || hasLocalStorage){
    DB.users    = sanitizeUsers(await sget("pdv:users"));
    DB.products = sanitizeProducts(await sget("pdv:products"));
    DB.sales    = sanitizeSales(await sget("pdv:sales"));
    DB.cash     = sanitizeCash(await sget("pdv:cash")) || { open:null, history:[] };
    applySettings(await sget("pdv:settings"));
  }
  if(!Array.isArray(DB.sales)){ DB.sales = []; await saveSales(); }
  if(!cloud){
    /* modo 100% local: preserva o comportamento original — semeia
       usuários/estoque de demonstração e garante sempre um admin e um gerente */
    if(!Array.isArray(DB.users)   || !DB.users.length){ DB.users = [{...SEED_ADMIN}, ...SEED_USERS.map(u=>({...u}))]; await saveUsers(); }
    if(!Array.isArray(DB.products)){ DB.products = SEED_PRODUCTS.map(p=>({...p})); await saveProducts(); }
    ensureManagerAccess();
    ensureAdminAccess();
  }else{
    /* modo nuvem: nada de dados de demonstração — o aparelho começa
       "vazio" até um login real rotear e vincular a uma empresa */
    if(!Array.isArray(DB.users)) DB.users = [];
    if(!Array.isArray(DB.products)) DB.products = [];
  }

  if(!storageOK) markStorageFailure();
  wire();
  await restoreSession();
  /* nuvem (opcional): inicializa em segundo plano, nunca atrasa a abertura */
  if(typeof cloudInit==="function") cloudInit();
}

