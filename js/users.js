"use strict";
/* ================================================================
   GERÊNCIA — usuários e permissões
   ================================================================ */
function renderUsers(){
  const el=$("userList"); if(!el) return;
  if(!DB.users.length){ el.innerHTML='<div class="empty-list">Nenhum usuário cadastrado.</div>'; return; }
  const meUser = state.user ? state.user.username : null;
  el.innerHTML=DB.users.map(u=>{
    const isGer = u.role==="gerente";
    const isMe  = u.username===meUser;
    // não dá pra excluir a si mesmo; contas de gerência são geridas só
    // pelo admin da plataforma, então a gerência não exclui outro gerente por aqui
    const lockDel = isMe || isGer;
    const roleTag = isGer ? '<span class="urole ger">Gerência</span>' : '<span class="urole">Caixa</span>';
    const perm = isGer
      ? '<div class="unote">Acesso total ao estoque (gerência).</div>'
      : `<label class="permline"><input type="checkbox" data-act="togglestock" ${u.canAddStock?"checked":""} /> <span>Pode adicionar itens ao estoque</span></label>`;
    return `<div class="urow" data-username="${escapeHtml(u.username)}">
      <div class="utop">
        <div class="uinfo">
          <div class="uname">${escapeHtml(u.name||u.username)}${roleTag}</div>
          <div class="umeta">@${escapeHtml(u.username)}</div>
        </div>
        <button class="prow-del" data-act="deluser" title="Excluir usuário" ${lockDel?"disabled style=\"opacity:.35;pointer-events:none\"":""}>✕</button>
      </div>
      ${perm}
    </div>`;
  }).join("");
}

/* a gerência só cadastra CAIXA por aqui — gerente é papel exclusivo do
   admin da plataforma (admin.html), que também define a qual empresa o
   gerente pertence; ver manager_create_cashier em supabase/schema.sql */
async function addUser(){
  if(addUser.busy) return; // evita cadastro duplicado por duplo toque
  addUser.busy=true;
  try{
    const name=$("nu_name").value.trim();
    const username=$("nu_user").value.trim().toLowerCase();
    const password=$("nu_pass").value;
    const stock=$("nu_stock").checked;
    const err=$("nu_err");

    if(!name){ err.textContent="Informe o nome do usuário."; return; }
    if(!/^[a-z0-9._-]{3,20}$/.test(username)){ err.textContent="Usuário: 3 a 20 caracteres (letras, números, . _ -)."; return; }
    if(DB.users.some(u=>u.username.toLowerCase()===username)){ err.textContent="Já existe um usuário com esse login."; return; }
    if(!password || password.length<4){ err.textContent="A senha precisa ter ao menos 4 caracteres."; return; }

    const user={ username, role:"operador", name, canAddStock:stock };
    const h=await hashPassword(password);

    if(typeof cloudOn==="function" && cloudOn()){
      // nuvem ativa: o cadastro tem que ser aceito pelo banco (RPC
      // manager_create_cashier) — é lá que a empresa do gerente logado
      // é resolvida e gravada automaticamente no novo caixa
      if(!h){ err.textContent="Não foi possível gerar uma senha segura neste navegador."; return; }
      const res=await cloudCreateCashier(username, name, h, stock);
      if(!res.ok){ err.textContent="Não foi possível cadastrar na nuvem — tente de novo."; return; }
      user.passHash=h;
    }else if(h){ user.passHash=h; }else{ user.password=password; }

    DB.users.push(user);
    saveUsers();
    ["nu_name","nu_user","nu_pass"].forEach(id=>$(id).value="");
    $("nu_stock").checked=false;
    err.textContent="";
    renderUsers();
    toast("✓ "+name+" cadastrado","ok");
  }finally{ addUser.busy=false; }
}

async function toggleUserStock(username,allow){
  const u=DB.users.find(x=>x.username===username); if(!u||u.role==="gerente") return;
  if(typeof cloudOn==="function" && cloudOn()){
    const res=await cloudSetCashierStock(username, allow);
    if(!res.ok){ toast("Não foi possível salvar na nuvem — tente de novo.","bad"); renderUsers(); return; }
  }
  u.canAddStock=!!allow;
  saveUsers();
  // se o próprio operador alterado estiver logado em outra aba, a sincronização atualiza o botão
  toast(allow?("✓ "+(u.name||u.username)+" pode repor estoque"):("Permissão removida de "+(u.name||u.username)), allow?"ok":"bad");
}

function deleteUser(username){
  const u=DB.users.find(x=>x.username===username); if(!u) return;
  if(state.user && u.username===state.user.username){ toast("Você não pode excluir o próprio usuário","bad"); return; }
  if(u.role==="gerente"){ toast("Contas de gerência são geridas pelo administrador da plataforma","bad"); return; }
  askConfirm("Excluir usuário","Remover \""+(u.name||u.username)+"\" do acesso ao sistema?",async ()=>{
    if(typeof cloudOn==="function" && cloudOn()){
      const res=await cloudDeleteCashier(username);
      if(!res.ok){ toast("Não foi possível remover na nuvem — tente de novo.","bad"); return; }
    }
    DB.users=DB.users.filter(x=>x.username!==username);
    saveUsers(); renderUsers();
    toast("Usuário removido","bad");
  },"Excluir");
}

