"use strict";
/* ================================================================
   CONSOLE DO ADMINISTRADOR DA PLATAFORMA (admin.html)

   Para a conta dona do SaaS: lista todas as empresas (lojas) e gerencia
   os acessos de gerente/caixa de cada uma. O acesso é liberado pelo
   Row Level Security: só contas presentes na tabela `admins` enxergam
   as lojas dos outros (veja supabase/schema.sql para promover a sua).

   Os usuários de uma empresa vivem no documento kv key='users' da loja;
   o PDV dos aparelhos puxa as mudanças na próxima sincronização.
   ================================================================ */
/* mesma versão pinada + SRI de js/cloud.js — mantenha as duas em sincronia */
const ADMIN_LIB_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
const ADMIN_LIB_SRI = "sha384-GFr3yTh5lJznCbZfpTtXnwboFsxqtTQoeTZCRHhE0579KrRmlCzen5AA8ohaB5ug";
const $ = (id)=>document.getElementById(id);

let sb = null;
let curStore = null;   // { id, name, email }
let curUsers = [];

/* mesma derivação de senha do app (js/auth.js) — mantenha em sincronia */
async function hashPassword(pw){
  try{
    if(window.crypto && crypto.subtle && window.TextEncoder){
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("pdv#v1:"+pw));
      return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
    }
  }catch(e){}
  return null;
}
const esc = (s)=>String(s==null?"":s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function cfgOk(){ return typeof CLOUD_CONFIG!=="undefined" && CLOUD_CONFIG && CLOUD_CONFIG.url && CLOUD_CONFIG.anonKey; }
function loadLib(){
  return new Promise((res,rej)=>{
    if(window.supabase && window.supabase.createClient) return res();
    const s=document.createElement("script");
    s.src=ADMIN_LIB_URL;
    s.integrity=ADMIN_LIB_SRI; s.crossOrigin="anonymous"; s.referrerPolicy="no-referrer";
    s.onload=()=>res(); s.onerror=()=>rej(new Error("lib"));
    document.head.appendChild(s);
  });
}

async function init(){
  if(!cfgOk()){ $("admErr").textContent="Nuvem não configurada — preencha js/config.js primeiro."; $("admLoginBtn").disabled=true; return; }
  try{
    await loadLib();
    sb = window.supabase.createClient(CLOUD_CONFIG.url, CLOUD_CONFIG.anonKey);
    const { data } = await sb.auth.getSession();
    if(data && data.session && await isAdmin()) enter((data.session.user&&data.session.user.email)||"");
  }catch(e){ $("admErr").textContent="Não foi possível falar com a nuvem — recarregue."; }
}

async function isAdmin(){
  const { data, error } = await sb.from("admins").select("user_id").maybeSingle();
  return !error && !!data;
}

async function doLogin(){
  const email=$("admEmail").value.trim(), pass=$("admPass").value;
  $("admErr").textContent="";
  if(!email || !pass){ $("admErr").textContent="Informe e-mail e senha."; return; }
  const { error } = await sb.auth.signInWithPassword({ email, password:pass });
  if(error){ $("admErr").textContent="E-mail ou senha incorretos."; return; }
  if(!(await isAdmin())){
    await sb.auth.signOut();
    $("admErr").textContent="Esta conta não é administradora da plataforma.";
    return;
  }
  $("admPass").value="";
  enter(email);
}

function enter(email){
  $("admWho").textContent=email;
  $("admLogin").style.display="none";
  $("admStore").style.display="none";
  $("admStores").style.display="";
  loadStores();
}

async function createStore(){
  const name=$("ns_name").value.trim();
  const email=$("ns_email").value.trim();
  const err=$("ns_err"); err.textContent="";
  if(!name){ err.textContent="Informe o nome da empresa."; return; }
  const { error } = await sb.from("stores").insert({ name, email });
  if(error){ err.textContent="Não foi possível criar — tente de novo."; return; }
  $("ns_name").value=""; $("ns_email").value="";
  await loadStores();
}

async function loadStores(){
  const { data, error } = await sb.from("stores").select("id,name,email,created_at");
  const el=$("storeList");
  if(error){ el.innerHTML='<div class="err">Erro ao listar as empresas.</div>'; return; }
  if(!data || !data.length){ el.innerHTML='<div class="sub">Nenhuma empresa cadastrada ainda.</div>'; return; }
  el.innerHTML = data.map(s=>`
    <div class="store" data-id="${esc(s.id)}">
      <div class="grow"><div class="nm">${esc(s.name)}</div><div class="em">${esc(s.email)}</div></div>
      <span class="tag">abrir →</span>
    </div>`).join("");
  el.querySelectorAll(".store").forEach(div=>{
    div.addEventListener("click", ()=>openStore(data.find(s=>s.id===div.dataset.id)));
  });
}

async function openStore(store){
  curStore = store;
  $("stName").value = store.name;
  $("stEmail").textContent = "Conta da loja: "+(store.email||"—");
  $("uMsg").textContent=""; $("nu_err").textContent="";
  $("nu_user").value=""; $("nu_name").value=""; $("nu_pass").value=""; $("nu_role").value="operador";
  await loadUsers();
  await loadDevices();
  $("admStores").style.display="none";
  $("admStore").style.display="";
}

const fmtDT=(iso)=>{ try{ return new Date(iso).toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}); }catch(e){ return "—"; } };

async function loadDevices(){
  const { data, error } = await sb.from("device_links")
    .select("auth_uid,username,linked_at").eq("store_id", curStore.id);
  const el=$("deviceList");
  if(error){ el.innerHTML='<div class="err">Erro ao listar os aparelhos.</div>'; return; }
  if(!data || !data.length){ el.innerHTML='<div class="sub">Nenhum aparelho vinculado ainda — o vínculo acontece sozinho no primeiro login de cada usuário.</div>'; return; }
  el.innerHTML = data.map(d=>`
    <div class="device" data-uid="${esc(d.auth_uid)}">
      <div class="grow"><span class="nm">@${esc(d.username||"?")}</span> <span class="dt">vinculado em ${fmtDT(d.linked_at)}</span></div>
      <button class="btn btn-bad btn-sm" data-uid="${esc(d.auth_uid)}">revogar</button>
    </div>`).join("");
  el.querySelectorAll("button[data-uid]").forEach(b=>{
    b.addEventListener("click", ()=>revokeDevice(b.dataset.uid));
  });
}

async function revokeDevice(authUid){
  if(!confirm("Revogar este aparelho? Ele para de sincronizar com a empresa a partir de agora.")) return;
  const { error } = await sb.from("device_links").delete().eq("auth_uid", authUid);
  if(!error){ $("uMsg").textContent="✓ Aparelho revogado."; await loadDevices(); }
}

async function loadUsers(){
  const { data, error } = await sb.from("kv").select("value")
    .eq("store_id", curStore.id).eq("key","users").maybeSingle();
  curUsers = (!error && data && Array.isArray(data.value)) ? data.value : [];
  renderUsers();
}

function renderUsers(){
  const el=$("userList");
  if(!curUsers.length){ el.innerHTML='<div class="sub">Nenhum acesso ainda — cadastre pelo menos um gerente abaixo para a empresa poder logar.</div>'; return; }
  el.innerHTML = curUsers.map((u,i)=>`
    <div class="user">
      <div class="grow"><span class="nm">${esc(u.name||u.username)}</span> <span class="un">@${esc(u.username)}</span></div>
      <span class="tag ${u.role==="gerente"?"g":""}">${u.role==="gerente"?"Gerente":"Caixa"}</span>
      ${u.role!=="gerente" ? `<button class="btn btn-ghost btn-sm" data-a="perm" data-i="${i}">${u.canAddStock?"✓ repõe estoque":"sem reposição"}</button>` : ""}
      <button class="btn btn-ghost btn-sm" data-a="pass" data-i="${i}">nova senha</button>
      <button class="btn btn-bad btn-sm" data-a="del" data-i="${i}">remover</button>
    </div>`).join("");
  el.querySelectorAll("button").forEach(b=>{
    b.addEventListener("click", ()=>userAction(b.dataset.a, Number(b.dataset.i)));
  });
}

async function saveUsers(msg){
  const { error } = await sb.from("kv").upsert({ store_id:curStore.id, key:"users", value:curUsers });
  if(error){ $("uMsg").textContent=""; $("nu_err").textContent="Erro ao salvar — tente de novo."; return false; }
  $("nu_err").textContent="";
  $("uMsg").textContent=msg+" Os aparelhos da loja recebem na próxima sincronização.";
  renderUsers();
  return true;
}

async function userAction(action,i){
  const u=curUsers[i]; if(!u) return;
  if(action==="perm"){
    u.canAddStock=!u.canAddStock;
    await saveUsers(`✓ Permissão de ${u.username} atualizada.`);
  }
  if(action==="pass"){
    const pw=prompt(`Nova senha para @${u.username} (mín. 4 caracteres):`);
    if(pw==null) return;
    if(pw.length<4){ alert("Senha muito curta."); return; }
    const h=await hashPassword(pw);
    if(h){ u.passHash=h; delete u.password; } else { u.password=pw; delete u.passHash; }
    await saveUsers(`✓ Senha de ${u.username} trocada.`);
  }
  if(action==="del"){
    if(u.role==="gerente" && curUsers.filter(x=>x.role==="gerente").length<=1){
      alert("Não dá para remover o último gerente da empresa."); return;
    }
    if(!confirm(`Remover o acesso de @${u.username}?`)) return;
    curUsers.splice(i,1);
    await saveUsers(`✓ Acesso de ${u.username} removido.`);
  }
}

async function addUser(){
  const username=$("nu_user").value.trim().toLowerCase();
  const name=$("nu_name").value.trim();
  const role=$("nu_role").value;
  const pw=$("nu_pass").value;
  const err=$("nu_err"); err.textContent="";
  if(!/^[a-z0-9._-]{2,20}$/.test(username)){ err.textContent="Login inválido (2–20 letras/números, sem espaços)."; return; }
  if(curUsers.some(x=>x.username.toLowerCase()===username)){ err.textContent="Já existe um acesso com este login."; return; }
  if(pw.length<4){ err.textContent="Senha muito curta (mín. 4 caracteres)."; return; }
  const nu={ username, name:name||username, role, canAddStock:false };
  const h=await hashPassword(pw);
  if(h) nu.passHash=h; else nu.password=pw;
  curUsers.push(nu);
  if(await saveUsers(`✓ ${username} adicionado como ${role==="gerente"?"gerente":"caixa"}.`)){
    $("nu_user").value=""; $("nu_name").value=""; $("nu_pass").value="";
  }
}

async function saveStoreName(){
  const name=$("stName").value.trim() || "Minha loja";
  const { error } = await sb.from("stores").upsert({ id:curStore.id, name });
  if(!error){ curStore.name=name; $("uMsg").textContent="✓ Nome da empresa salvo."; }
}

$("admLoginBtn").addEventListener("click", doLogin);
$("admPass").addEventListener("keydown", e=>{ if(e.key==="Enter") doLogin(); });
$("admLogoutBtn").addEventListener("click", async ()=>{ await sb.auth.signOut(); location.reload(); });
$("backBtn").addEventListener("click", ()=>{ $("admStore").style.display="none"; $("admStores").style.display=""; loadStores(); });
$("stSaveBtn").addEventListener("click", saveStoreName);
$("ns_addBtn").addEventListener("click", createStore);
$("nu_addBtn").addEventListener("click", addUser);
init();
