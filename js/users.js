"use strict";
/* ================================================================
   GERÊNCIA — usuários e permissões
   ================================================================ */
/* gestão de caixas (operadores): restrita ao gerente logado e à sua própria
   empresa — nunca lista, edita ou remove usuários de outra empresa nem
   contas de admin/gerência (isolamento de tenant: Admin → Gerente → Caixa) */
function renderUsers(){
  const el=$("userList"); if(!el) return;
  if(!state.user || state.user.role!=="gerente"){ el.innerHTML=""; return; }
  const meUser = state.user.username;
  const myCompany = state.user.empresa;
  const cashiers = DB.users.filter(u=>u.role==="operador" && u.empresa===myCompany);
  if(!cashiers.length){ el.innerHTML='<div class="empty-list">Nenhum usuário cadastrado.</div>'; return; }
  el.innerHTML=cashiers.map(u=>{
    const isMe = u.username===meUser;
    const perm = `<label class="permline"><input type="checkbox" data-act="togglestock" ${u.canAddStock?"checked":""} /> <span>Pode adicionar itens ao estoque</span></label>`;
    return `<div class="urow" data-username="${escapeHtml(u.username)}">
      <div class="utop">
        <div class="uinfo">
          <div class="uname">${escapeHtml(u.name||u.username)}<span class="urole">Caixa</span></div>
          <div class="umeta">@${escapeHtml(u.username)}</div>
        </div>
        <button class="prow-del" data-act="deluser" title="Excluir usuário" ${isMe?"disabled style=\"opacity:.35;pointer-events:none\"":""}>✕</button>
      </div>
      ${perm}
    </div>`;
  }).join("");
}

async function addUser(){
  if(addUser.busy) return; // evita cadastro duplicado por duplo toque
  addUser.busy=true;
  try{
    const err=$("nu_err");
    if(!state.user || state.user.role!=="gerente"){ err.textContent="Apenas a gerência pode cadastrar caixas."; return; }
    if(!state.user.empresa){ err.textContent="Sua conta ainda não está vinculada a uma empresa. Fale com o administrador."; return; }

    const name=$("nu_name").value.trim();
    const username=$("nu_user").value.trim().toLowerCase();
    const password=$("nu_pass").value;
    const stock=$("nu_stock").checked;

    if(!name){ err.textContent="Informe o nome do usuário."; return; }
    if(!/^[a-z0-9._-]{3,20}$/.test(username)){ err.textContent="Usuário: 3 a 20 caracteres (letras, números, . _ -)."; return; }
    if(DB.users.some(u=>u.username.toLowerCase()===username)){ err.textContent="Já existe um usuário com esse login."; return; }
    if(!password || password.length<4){ err.textContent="A senha precisa ter ao menos 4 caracteres."; return; }

    // herança de tenant: todo caixa criado por um gerente pertence à mesma empresa dele
    const user={ username, role:"operador", name, canAddStock:stock, empresa:state.user.empresa, active:true };
    const h=await hashPassword(password);
    if(h) user.passHash=h; else user.password=password;
    DB.users.push(user);
    saveUsers();
    ["nu_name","nu_user","nu_pass"].forEach(id=>$(id).value="");
    $("nu_stock").checked=false;
    err.textContent="";
    renderUsers();
    toast("✓ "+name+" cadastrado","ok");
  }finally{ addUser.busy=false; }
}

function toggleUserStock(username,allow){
  if(!state.user || state.user.role!=="gerente") return;
  const u=DB.users.find(x=>x.username===username);
  if(!u || u.role!=="operador" || u.empresa!==state.user.empresa) return;
  u.canAddStock=!!allow;
  saveUsers();
  // se o próprio operador alterado estiver logado em outra aba, a sincronização atualiza o botão
  toast(allow?("✓ "+(u.name||u.username)+" pode repor estoque"):("Permissão removida de "+(u.name||u.username)), allow?"ok":"bad");
}

function deleteUser(username){
  if(!state.user || state.user.role!=="gerente") return;
  const u=DB.users.find(x=>x.username===username);
  if(!u || u.role!=="operador" || u.empresa!==state.user.empresa) return;
  askConfirm("Excluir usuário","Remover \""+(u.name||u.username)+"\" do acesso ao sistema?",()=>{
    DB.users=DB.users.filter(x=>x.username!==username);
    saveUsers(); renderUsers();
    toast("Usuário removido","bad");
  },"Excluir");
}

