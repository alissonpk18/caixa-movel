"use strict";
/* ================================================================
   ADMINISTRADOR GLOBAL — cadastro e gestão de acesso das gerências

   Hierarquia de tenant: Admin (global, sem empresa) → Gerente (empresa)
   → Caixa (herda a empresa do gerente que o cadastrou). Só o admin cria,
   edita e liga/desliga o acesso de contas de gerência; o gerente nunca
   enxerga nem gerencia gerências de outras empresas.
   ================================================================ */
function renderAdmin(){
  const el=$("managerList"); if(!el) return;
  if(!state.user || state.user.role!=="admin"){ el.innerHTML=""; return; }
  const managers=DB.users.filter(u=>u.role==="gerente");
  if(!managers.length){ el.innerHTML='<div class="empty-list">Nenhuma gerência cadastrada.</div>'; return; }
  el.innerHTML=managers.map(u=>{
    const active=u.active!==false;
    const roleTag=active ? '<span class="urole ger">Gerência</span>' : '<span class="urole off">Desativado</span>';
    return `<div class="urow" data-username="${escapeHtml(u.username)}">
      <div class="utop">
        <div class="uinfo">
          <div class="uname">${escapeHtml(u.name||u.username)}${roleTag}</div>
          <div class="umeta">@${escapeHtml(u.username)}</div>
        </div>
        <button class="prow-del" data-act="delmanager" title="Excluir gerência">✕</button>
      </div>
      <input class="uempresa" type="text" data-f="empresa" value="${escapeHtml(u.empresa||"")}" placeholder="Empresa (obrigatório)" />
      <div class="urow-actions">
        <button class="btn btn-ghost" data-act="toggleactive">${active?"Desativar acesso":"Ativar acesso"}</button>
      </div>
    </div>`;
  }).join("");
}

async function addManager(){
  if(addManager.busy) return; // evita cadastro duplicado por duplo toque
  addManager.busy=true;
  try{
    const err=$("ng_err");
    if(!state.user || state.user.role!=="admin"){ err.textContent="Apenas o administrador global cadastra gerências."; return; }

    const name=$("ng_name").value.trim();
    const username=$("ng_user").value.trim().toLowerCase();
    const password=$("ng_pass").value;
    const empresa=$("ng_empresa").value.trim();

    if(!name){ err.textContent="Informe o nome do responsável."; return; }
    if(!/^[a-z0-9._-]{3,20}$/.test(username)){ err.textContent="Usuário: 3 a 20 caracteres (letras, números, . _ -)."; return; }
    if(DB.users.some(u=>u.username.toLowerCase()===username)){ err.textContent="Já existe um usuário com esse login."; return; }
    if(!password || password.length<4){ err.textContent="A senha precisa ter ao menos 4 caracteres."; return; }
    if(!empresa){ err.textContent="Informe a empresa à qual esta gerência pertence."; return; }

    // vínculo de tenant: gravado na criação, junto do papel de gerência
    const user={ username, role:"gerente", name, canAddStock:true, empresa, active:true };
    const h=await hashPassword(password);
    if(h) user.passHash=h; else user.password=password;
    DB.users.push(user);
    saveUsers();
    ["ng_name","ng_user","ng_pass","ng_empresa"].forEach(id=>$(id).value="");
    err.textContent="";
    renderAdmin();
    toast("✓ "+name+" cadastrado como gerência","ok");
  }finally{ addManager.busy=false; }
}

function toggleManagerActive(username){
  if(!state.user || state.user.role!=="admin") return;
  const u=DB.users.find(x=>x.username===username); if(!u||u.role!=="gerente") return;
  u.active = u.active===false; // alterna: desativado→ativo, ativo→desativado
  saveUsers(); renderAdmin();
  toast(u.active?("✓ Acesso de "+(u.name||u.username)+" reativado"):("Acesso de "+(u.name||u.username)+" desativado"), u.active?"ok":"bad");
}

function updateManagerCompany(username, value){
  if(!state.user || state.user.role!=="admin") return;
  const u=DB.users.find(x=>x.username===username); if(!u||u.role!=="gerente") return;
  const empresa=String(value||"").trim();
  if(!empresa){ toast("Informe uma empresa válida","bad"); renderAdmin(); return; }
  u.empresa=empresa;
  saveUsers();
  toast("✓ Empresa de "+(u.name||u.username)+" atualizada","ok");
}

function deleteManager(username){
  if(!state.user || state.user.role!=="admin") return;
  const u=DB.users.find(x=>x.username===username); if(!u||u.role!=="gerente") return;
  askConfirm("Excluir gerência","Remover \""+(u.name||u.username)+"\"? Os caixas da empresa \""+(u.empresa||"—")+"\" ficam sem gerente até outra gerência ser cadastrada para ela.",()=>{
    DB.users=DB.users.filter(x=>x.username!==username);
    saveUsers(); renderAdmin();
    toast("Gerência removida","bad");
  },"Excluir");
}
