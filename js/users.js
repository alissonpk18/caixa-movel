"use strict";
/* ================================================================
   GERÊNCIA — usuários e permissões
   ================================================================ */
/* com a nuvem configurada, os acessos (gerente/caixa) são geridos
   EXCLUSIVAMENTE pelo console do admin (tabela operators — o RLS nem
   deixa o aparelho escrever nela): qualquer edição local nunca subiria
   e seria desfeita em silêncio pelo pull seguinte. Então o painel do
   aparelho vira só uma vitrine do que está valendo. */
function usersManagedByCloud(){ return typeof cloudEnabled==="function" && cloudEnabled(); }

function renderUsers(){
  const el=$("userList"); if(!el) return;
  const managed = usersManagedByCloud();
  // com a nuvem, a gerência ainda cadastra caixas (RPC create_operator);
  // só promover a gerência, trocar senha ou remover acesso ficam com o
  // console do admin — daí o seletor de perfil ficar travado em "Caixa"
  const roleSel=$("nu_role");
  if(roleSel){
    roleSel.querySelectorAll('option[value="gerente"]').forEach(o=>o.style.display = managed ? "none" : "");
    if(managed && roleSel.value==="gerente") roleSel.value="operador";
    roleSel.disabled = managed;
  }
  const note=$("usersCloudNote"); if(note) note.style.display = managed ? "" : "none";
  if(!DB.users.length){ el.innerHTML='<div class="empty-list">Nenhum usuário cadastrado.</div>'; return; }
  const meUser = state.user ? state.user.username : null;
  const managers = DB.users.filter(u=>u.role==="gerente").length;
  el.innerHTML=DB.users.map(u=>{
    const isGer = u.role==="gerente";
    const isMe  = u.username===meUser;
    // não dá pra excluir a si mesmo nem o último gerente (evita travar o acesso)
    const lockDel = isMe || (isGer && managers<=1);
    const roleTag = isGer ? '<span class="urole ger">Gerência</span>' : '<span class="urole">Caixa</span>';
    const perm = isGer
      ? '<div class="unote">Acesso total ao estoque (gerência).</div>'
      : managed
        ? `<div class="unote">${u.canAddStock?"Pode adicionar itens ao estoque.":"Sem permissão de reposição de estoque."}</div>`
        : `<label class="permline"><input type="checkbox" data-act="togglestock" ${u.canAddStock?"checked":""} /> <span>Pode adicionar itens ao estoque</span></label>`;
    return `<div class="urow" data-username="${escapeHtml(u.username)}">
      <div class="utop">
        <div class="uinfo">
          <div class="uname">${escapeHtml(u.name||u.username)}${roleTag}</div>
          <div class="umeta">@${escapeHtml(u.username)}</div>
        </div>
        ${managed?"":`<button class="prow-del" data-act="deluser" title="Excluir usuário" ${lockDel?"disabled style=\"opacity:.35;pointer-events:none\"":""}>✕</button>`}
      </div>
      ${perm}
    </div>`;
  }).join("");
}

function syncRolePerm(){
  // o checkbox de permissão só faz sentido para operador; gerência já tem acesso total
  const isGer = $("nu_role").value==="gerente";
  $("nu_permLine").classList.toggle("off", isGer);
}

async function addUser(){
  if(addUser.busy) return; // evita cadastro duplicado por duplo toque
  addUser.busy=true;
  try{
    const managed = usersManagedByCloud();
    const name=$("nu_name").value.trim();
    const username=$("nu_user").value.trim().toLowerCase();
    const password=$("nu_pass").value;
    // com a nuvem, a gerência só cadastra caixas por aqui (promover a
    // gerência é exclusivo do console do admin — veja renderUsers)
    const role= managed ? "operador" : ($("nu_role").value==="gerente" ? "gerente" : "operador");
    const stock = role==="gerente" ? true : $("nu_stock").checked;
    const err=$("nu_err");

    if(!name){ err.textContent="Informe o nome do usuário."; return; }
    if(!/^[a-z0-9._-]{3,20}$/.test(username)){ err.textContent="Usuário: 3 a 20 caracteres (letras, números, . _ -)."; return; }
    if(DB.users.some(u=>u.username.toLowerCase()===username)){ err.textContent="Já existe um usuário com esse login."; return; }
    if(!password || password.length<4){ err.textContent="A senha precisa ter ao menos 4 caracteres."; return; }

    if(managed){
      if(typeof cloudCreateOperator!=="function"){ err.textContent="Recurso indisponível."; return; }
      const res=await cloudCreateOperator({ username, name, canAddStock:stock, password });
      if(res.error){ err.textContent=res.error; return; }
    }else{
      const user={ username, role, name, canAddStock:stock };
      const h=await hashPassword(password);
      if(h) user.passHash=h; else user.password=password;
      DB.users.push(user);
      saveUsers();
    }
    ["nu_name","nu_user","nu_pass"].forEach(id=>$(id).value="");
    $("nu_role").value="operador"; $("nu_stock").checked=false; syncRolePerm();
    err.textContent="";
    renderUsers();
    toast("✓ "+name+" cadastrado","ok");
  }finally{ addUser.busy=false; }
}

function toggleUserStock(username,allow){
  if(usersManagedByCloud()){ toast("Permissões são alteradas pelo console do administrador","bad"); renderUsers(); return; }
  const u=DB.users.find(x=>x.username===username); if(!u||u.role==="gerente") return;
  u.canAddStock=!!allow;
  saveUsers();
  // se o próprio operador alterado estiver logado em outra aba, a sincronização atualiza o botão
  toast(allow?("✓ "+(u.name||u.username)+" pode repor estoque"):("Permissão removida de "+(u.name||u.username)), allow?"ok":"bad");
}

function deleteUser(username){
  if(usersManagedByCloud()){ toast("Acessos são removidos pelo console do administrador","bad"); return; }
  const u=DB.users.find(x=>x.username===username); if(!u) return;
  if(state.user && u.username===state.user.username){ toast("Você não pode excluir o próprio usuário","bad"); return; }
  if(u.role==="gerente" && DB.users.filter(x=>x.role==="gerente").length<=1){ toast("Mantenha ao menos um usuário de gerência","bad"); return; }
  askConfirm("Excluir usuário","Remover \""+(u.name||u.username)+"\" do acesso ao sistema?",()=>{
    DB.users=DB.users.filter(x=>x.username!==username);
    saveUsers(); renderUsers();
    toast("Usuário removido","bad");
  },"Excluir");
}

