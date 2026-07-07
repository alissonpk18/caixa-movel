"use strict";
/* ================================================================
   NAVEGAÇÃO ENTRE TELAS
   ================================================================ */
function show(screenId){
  document.querySelectorAll(".screen").forEach(s=>s.classList.toggle("is-active", s.id===screenId));
}

function enterApp(found){
  state.user=found;
  initAudio();
  saveSession();
  if(found.role==="gerente"){
    $("gerName").innerHTML = "Gerência<small>"+escapeHtml(found.name||"")+"</small>";
    show("gerente"); renderManager();
  }else{
    $("opName").innerHTML = escapeHtml(found.name||"Caixa")+"<small>Operador</small>";
    $("restockBtn").style.display = canAddStock(found) ? "" : "none";
    clearCart();
    show("operador"); startScanner();
  }
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
    let found = DB.users.find(x=>x.username.toLowerCase()===u);
    let ok = found ? await verifyPassword(found,p) : false;
    /* usuário não existe neste aparelho: pergunta à nuvem de qual empresa
       ele é (RPC login_operator, senha conferida no banco) — se bater,
       vincula o aparelho e baixa os dados da empresa automaticamente */
    if(!ok && typeof cloudRouteLogin==="function" && await cloudRouteLogin(u,p)){
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
  stopScanner();
  state.user=null; state.cart=[];
  saveSession();
  $("loginUser").value=""; $("loginPass").value="";
  show("login");
}

