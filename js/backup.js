"use strict";
/* ---------- backup: exportar/importar tudo em JSON ---------- */
function exportBackup(){
  const data={
    app:"pdv-caixa-rapido", version:1, exportedAt:new Date().toISOString(),
    users:DB.users, products:DB.products, sales:DB.sales, cash:DB.cash, settings
  };
  const blob=new Blob([JSON.stringify(data,null,1)],{type:"application/json"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url; a.download="pdv-backup-"+keyToIso(todayKey())+".json";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast("✓ Backup exportado","ok");
}
function importBackup(file){
  const err=$("backupErr"); err.textContent="";
  if(!file) return;
  const reader=new FileReader();
  reader.onerror=()=>{ err.textContent="Não foi possível ler o arquivo."; };
  reader.onload=()=>{
    let data=null;
    try{ data=JSON.parse(String(reader.result)); }catch(e){}
    if(!data || typeof data!=="object"){ err.textContent="Arquivo inválido (não é um backup do PDV)."; return; }
    const users=sanitizeUsers(data.users);
    const products=sanitizeProducts(data.products);
    const sales=sanitizeSales(data.sales);
    const cash=sanitizeCash(data.cash);
    if(!users || !users.length || !products || !sales){
      err.textContent="Backup incompleto ou corrompido — nada foi alterado."; return;
    }
    askConfirm("Importar backup",
      "Substituir TODOS os dados atuais pelos do arquivo ("+products.length+" produtos, "+sales.length+" vendas, "+users.length+" usuários)?",
      ()=>{
        DB.users=users; DB.products=products; DB.sales=sales;
        DB.cash=cash||{open:null,history:[]};
        applySettings(data.settings);
        ensureManagerAccess();
        saveUsers(); saveProducts(); saveSales(); saveCash(); saveSettings();
        // restauração é uma correção absoluta de cada quantidade (ver js/cloud.js)
        if(typeof cloudEnqueueStockSet==="function") products.forEach(p=>cloudEnqueueStockSet(p.code, p.qty));
        renderManager();
        toast("✓ Backup restaurado","ok");
      },"Substituir tudo");
  };
  reader.readAsText(file);
}

function cancelSale(){
  if(!state.cart.length) return;
  askConfirm("Cancelar venda","Isso vai remover todos os itens da venda atual.",()=>{
    clearCart();
    setStatus("Venda cancelada","bad");
  },"Cancelar venda");
}

