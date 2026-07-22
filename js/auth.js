"use strict";
/* ================================================================
   NAVEGAÇÃO ENTRE TELAS
   ================================================================ */
function show(screenId){
  document.querySelectorAll(".screen").forEach(s=>s.classList.toggle("is-active", s.id===screenId));
}

/* topbar mostra o nome da empresa (baixado da nuvem) em destaque quando
   disponível, com o contexto (papel + usuário) na linha pequena embaixo.
   Sem nuvem configurada (ou ainda não sincronizado), cai no layout
   anterior — sem nome de empresa para mostrar, cada tela usa o que tem
   de mais útil em destaque (o rótulo fixo na gerência, o nome da pessoa
   no caixa). */
function topbarHtml(contextLabel, userName, fallbackBold, fallbackSmall){
  const company = (settings.storeName||"").trim();
  if(company){
    const ctx = userName ? contextLabel+" · "+escapeHtml(userName) : contextLabel;
    return escapeHtml(company)+"<small>"+ctx+"</small>";
  }
  return escapeHtml(fallbackBold)+"<small>"+escapeHtml(fallbackSmall)+"</small>";
}

function enterApp(found){
  state.user=found;
  initAudio();
  saveSession();
  if(found.role==="gerente"){
    $("gerName").innerHTML = topbarHtml("Gerência", found.name, "Gerência", found.name||"");
    show("gerente"); renderManager();
  }else{
    $("opName").innerHTML = topbarHtml("Operador", found.name, found.name||"Caixa", "Operador");
    $("restockBtn").style.display = canAddStock(found) ? "" : "none";
    $("backToGerBtn").style.display = "none";
    clearCart();
    resetSearch();
    show("operador");
  }
}

/* gerência: ir para o caixa sem encerrar a sessão (mesmo usuário, mesmas permissões) */
function enterCaixaFromManager(){
  if(!state.user || state.user.role!=="gerente") return;
  $("opName").innerHTML = topbarHtml("Gerência no caixa", state.user.name, state.user.name||"Caixa", "Gerência no caixa");
  $("restockBtn").style.display = canAddStock(state.user) ? "" : "none";
  $("backToGerBtn").style.display = "";
  clearCart();
  resetSearch();
  show("operador");
}

/* caixa: voltar para a gerência sem passar pelo login de novo */
function backToManager(){
  show("gerente");
  renderManager();
}

/* ---------- senhas ----------
   Sempre que o navegador expõe crypto.subtle (HTTPS/localhost, mesmo
   requisito da câmera), as senhas são guardadas apenas como hash SHA-256.
   Contas antigas em texto puro migram no primeiro login bem-sucedido. */
async function hashPassword(pw){
  try{
    if(window.crypto && crypto.subtle && window.TextEncoder){
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("pdv#v1:"+pw));
      return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
    }
  }catch(e){}
  return null; // sem suporte: mantém o comportamento anterior (texto puro)
}
async function verifyPassword(user,pass){
  if(typeof user.passHash==="string" && user.passHash){
    const h=await hashPassword(pass);
    return h!==null && h===user.passHash;
  }
  return user.password===pass;
}

async function login(){
  if(login.busy) return; // evita duplo submit enquanto o hash roda
  login.busy=true;
  try{
    const u=$("loginUser").value.trim().toLowerCase();
    const p=$("loginPass").value;
    
    let found = null;
    let ok = false;

    // Se estiver online e com nuvem ativada, tenta sempre validar na nuvem primeiro,
    // garantindo que possamos detectar mudanças de empresa para o mesmo login (ex: gerente/caixa)
    if(navigator.onLine && typeof cloudRouteLogin==="function"){
      if(await cloudRouteLogin(u,p)){
        found = DB.users.find(x=>x.username.toLowerCase()===u);
        ok = found ? await verifyPassword(found,p) : false;
      }
    }

    // Se falhou na nuvem (ou está offline/local), tenta a autenticação local
    if(!ok){
      found = DB.users.find(x=>x.username.toLowerCase()===u);
      ok = found ? await verifyPassword(found,p) : false;
    }

    if(!ok){ $("loginErr").textContent="Usuário ou senha incorretos."; beep("bad"); return; }
    if(!found.passHash){
      const h=await hashPassword(p);
      if(h){ found.passHash=h; delete found.password; saveUsers(); }
    }
    $("loginErr").textContent="";
    $("loginPass").value="";
    enterApp(found);
  }finally{ login.busy=false; }
}

async function restoreSession(){
  const sess = await sget("pdv:session");
  if(!sess || !sess.username) return false;
  const found = DB.users.find(x=>x.username===sess.username);
  if(!found) return false;
  enterApp(found);
  return true;
}

function logout(){
  $("scanModal").classList.remove("show");
  stopScanner();
  state.user=null; state.cart=[];
  saveSession();
  resetSearch();
  $("loginUser").value=""; $("loginPass").value="";
  show("login");
}

