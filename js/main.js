"use strict";
/* ================================================================
   WIRING (eventos)
   ================================================================ */
function wire(){
  if(wire.wired) return; // nunca duplica listeners (ex.: recuperação de erro do boot)
  wire.wired=true;

  // login
  $("loginBtn").addEventListener("click", login);
  $("loginPass").addEventListener("keydown", e=>{ if(e.key==="Enter") login(); });
  $("loginUser").addEventListener("keydown", e=>{ if(e.key==="Enter") $("loginPass").focus(); });

  // sair
  $("logoutOp").addEventListener("click", logout);
  $("logoutGer").addEventListener("click", logout);

  // mudo
  $("muteBtn").addEventListener("click", ()=>{
    state.muted=!state.muted;
    $("muteBtn").textContent=state.muted?"🔇":"🔊";
  });

  // câmera fallback (só descarta a instância se ela não estiver ligando/ligada)
  $("retryCam").addEventListener("click", ()=>{
    if(!state.scanReady && !state.scanStarting) state.scanner=null;
    startScanner();
  });
  $("manualBtn2").addEventListener("click", openManual);

  // busca de produtos (opção principal de adicionar itens ao carrinho)
  $("prodSearch2").addEventListener("input", e=>{ searchQuery=e.target.value; renderSearch(); });
  $("searchClear").addEventListener("click", ()=>{ searchQuery=""; $("prodSearch2").value=""; renderSearch(); $("prodSearch2").focus(); });
  $("searchResults").addEventListener("click", e=>{
    const b=e.target.closest(".search-item"); if(!b || b.disabled) return;
    addByCode(b.dataset.code);
    renderSearch(); // atualiza o estoque disponível exibido na lista
  });

  // leitor de código de barras (opção secundária, aberto sob demanda)
  $("openScanBtn").addEventListener("click", openScanModal);
  $("scanClose").addEventListener("click", closeScanModal);
  $("scanModal").addEventListener("click", e=>{ if(e.target.id==="scanModal") closeScanModal(); });

  // tocar fora da busca/resultados fecha a busca e volta pra tela normal do caixa
  document.addEventListener("click", e=>{
    if(!searchQuery) return;
    if(!$("operador").classList.contains("is-active")) return;
    if(e.target.closest(".searchbar") || e.target.closest("#searchResults")) return;
    $("prodSearch2").blur();
    resetSearch();
  }, true);

  // carrinho (delegação)
  $("cartList").addEventListener("click", e=>{
    const b=e.target.closest("button"); if(!b) return;
    const code=b.dataset.code, act=b.dataset.act;
    if(act==="plus") changeQty(code,+1);
    else if(act==="minus") changeQty(code,-1);
    else if(act==="del"){
      const it=state.cart.find(i=>i.code===code);
      askConfirm("Remover item","Remover "+(it?it.name:"este item")+" da venda?",()=>removeItem(code),"Remover");
    }
  });

  $("finalizeBtn").addEventListener("click", openPay);
  $("cancelBtn").addEventListener("click", cancelSale);

  // pagamento
  $("payMethods").addEventListener("click", e=>{ const b=e.target.closest("button"); if(b) selectMethod(b.dataset.m); });
  $("payCardType").addEventListener("click", e=>{ const b=e.target.closest("button"); if(b) selectCardType(b.dataset.c); });
  $("payReceived").addEventListener("input", updateChange);
  $("payClose").addEventListener("click", ()=>$("payModal").classList.remove("show"));
  $("payConfirm").addEventListener("click", confirmPay);
  $("payModal").addEventListener("click", e=>{ if(e.target.id==="payModal") $("payModal").classList.remove("show"); });

  // comprovante
  $("receiptClose").addEventListener("click", ()=>$("receiptModal").classList.remove("show"));
  $("receiptPrint").addEventListener("click", printReceipt);
  $("receiptShare").addEventListener("click", shareReceipt);
  $("receiptModal").addEventListener("click", e=>{ if(e.target.id==="receiptModal") $("receiptModal").classList.remove("show"); });

  // pix (config na gerência + copiar no pagamento)
  $("pixSaveBtn").addEventListener("click", savePixConfig);
  $("pixCopyBtn").addEventListener("click", copyPixCode);

  // caixa (operador)
  $("cashBtn").addEventListener("click", openCashModal);
  $("cashDismiss1").addEventListener("click", closeCashModal);
  $("cashDismiss2").addEventListener("click", closeCashModal);
  $("cashOpenBtn").addEventListener("click", openCash);
  $("cashSangria").addEventListener("click", ()=>cashMovement("sangria"));
  $("cashReforco").addEventListener("click", ()=>cashMovement("reforco"));
  $("cashStartClose").addEventListener("click", startCloseCash);
  $("cashBackBtn").addEventListener("click", renderCashModal);
  $("cashConfirmClose").addEventListener("click", confirmCloseCash);
  $("cashModal").addEventListener("click", e=>{ if(e.target.id==="cashModal") closeCashModal(); });

  // backup (gerência)
  $("backupExport").addEventListener("click", exportBackup);
  $("backupImportBtn").addEventListener("click", ()=>$("backupFile").click());
  $("backupFile").addEventListener("change", e=>{
    importBackup(e.target.files && e.target.files[0]);
    e.target.value=""; // permite importar o mesmo arquivo de novo
  });

  // leitor físico de código de barras (USB/Bluetooth): digita os dígitos e envia Enter.
  // Só age na tela do caixa e quando nenhum campo de texto está focado.
  let wedgeBuf="", wedgeT=0;
  document.addEventListener("keydown", e=>{
    if(!state.user || state.user.role!=="operador") return;
    if(!$("operador").classList.contains("is-active")) return;
    const tag=(document.activeElement&&document.activeElement.tagName)||"";
    if(tag==="INPUT"||tag==="TEXTAREA"||tag==="SELECT") return;
    const now=Date.now();
    if(now-wedgeT>250) wedgeBuf="";   // leitores digitam rápido; pausa longa = começo de outra leitura
    wedgeT=now;
    if(/^\d$/.test(e.key)){ wedgeBuf=(wedgeBuf+e.key).slice(-20); }
    else if(e.key==="Enter"){
      if(wedgeBuf.length>=6){ addByCode(wedgeBuf); e.preventDefault(); }
      wedgeBuf="";
    }else if(e.key!=="Shift"){ wedgeBuf=""; }
  });

  // gerência: tabs
  $("tabEstoque").addEventListener("click", ()=>switchTab("estoque"));
  $("tabVendas").addEventListener("click", ()=>switchTab("vendas"));
  $("tabUsuarios").addEventListener("click", ()=>switchTab("usuarios"));

  // gerência: cadastro de usuários e permissões
  $("addUserBtn").addEventListener("click", addUser);
  $("nu_role").addEventListener("change", syncRolePerm);
  $("nu_pass").addEventListener("keydown", e=>{ if(e.key==="Enter") addUser(); });
  $("userList").addEventListener("change", e=>{
    const cb=e.target.closest("[data-act='togglestock']"); if(!cb) return;
    const row=cb.closest(".urow"); toggleUserStock(row.dataset.username, cb.checked);
  });
  $("userList").addEventListener("click", e=>{
    const b=e.target.closest("[data-act='deluser']"); if(!b) return;
    const row=b.closest(".urow"); deleteUser(row.dataset.username);
  });

  // caixa: adicionar ao estoque (operador autorizado)
  $("restockBtn").addEventListener("click", openRestock);
  $("rs_code").addEventListener("input", updateRestockFound);
  $("rsClose").addEventListener("click", closeRestock);
  $("rsConfirm").addEventListener("click", confirmRestock);
  $("restockModal").addEventListener("click", e=>{ if(e.target.id==="restockModal") closeRestock(); });

  // gerência: editar estoque (delegação no change)
  $("prodList").addEventListener("change", e=>{
    const inp=e.target.closest("input"); if(!inp) return;
    const row=inp.closest(".prow"); const code=row.dataset.code;
    const p=findProduct(code); if(!p) return;
    if(inp.dataset.f==="name"){
      const v=inp.value.trim(); if(!v){ inp.value=p.name; return; }
      p.name=v; inp.value=v;
    }else if(inp.dataset.f==="price"){
      const v=parseMoney(inp.value); if(isNaN(v)||v<0||v>PRICE_MAX){ inp.value=p.price.toFixed(2); return; }
      p.price=round2(v); inp.value=p.price.toFixed(2);
    }else if(inp.dataset.f==="cost"){
      const raw=inp.value.trim();
      if(!raw){ p.cost=null; inp.value=""; }
      else{
        const v=parseMoney(raw);
        if(isNaN(v)||v<0||v>PRICE_MAX){ inp.value=typeof p.cost==="number"?p.cost.toFixed(2):""; return; }
        p.cost=round2(v); inp.value=p.cost.toFixed(2);
      }
    }else if(inp.dataset.f==="exp"){
      p.exp=isIsoDate(inp.value)?inp.value:null;
    }else{
      const v=parseInt(inp.value,10); if(isNaN(v)||v<0||v>QTY_MAX){ inp.value=p.qty; return; }
      p.qty=v;
      // correção manual: define o valor absoluto na nuvem (ver js/cloud.js)
      if(typeof cloudEnqueueStockSet==="function") cloudEnqueueStockSet(p.code, p.qty);
    }
    saveProducts();
    row.classList.toggle("low", p.qty<=settings.lowStock);
    const badge=row.querySelector(".stockbadge"); if(badge) badge.textContent=p.qty+" un · "+p.code;
    refreshExpRow(row,p); renderExpAlert();
    const s=row.querySelector(".saved"); s.classList.add("show"); setTimeout(()=>s.classList.remove("show"),1100);
  });

  // gerência: excluir produto (delegação no click)
  $("prodList").addEventListener("click", e=>{
    const b=e.target.closest("[data-act='delprod']"); if(!b) return;
    const row=b.closest(".prow"); const code=row.dataset.code;
    const p=findProduct(code); if(!p) return;
    askConfirm("Excluir produto","Remover \""+p.name+"\" do estoque? Esta ação não pode ser desfeita.",()=>{
      DB.products=DB.products.filter(x=>x.code!==code);
      saveProducts(); renderStock();
      toast("Produto removido","bad");
    },"Excluir");
  });

  $("addProdBtn").addEventListener("click", addProduct);

  // gerência: busca de produtos
  $("prodSearch").addEventListener("input", e=>{ prodQuery=e.target.value; renderStock(); });

  // gerência: limite de estoque baixo configurável
  $("lowThreshold").addEventListener("change", e=>{
    const v=parseInt(e.target.value,10);
    settings.lowStock=(isNaN(v)||v<0)?0:v;
    e.target.value=settings.lowStock;
    sset("pdv:settings", settings);
    renderStock();
  });

  // gerência: dias de antecedência para avisar validade
  $("expThreshold").addEventListener("change", e=>{
    const v=parseInt(e.target.value,10);
    settings.expWarnDays=(isNaN(v)||v<0)?0:v;
    e.target.value=settings.expWarnDays;
    sset("pdv:settings", settings);
    renderStock();
  });

  // gerência: filtro de vendas por data + export CSV
  $("salesDate").addEventListener("change", e=>{ salesFilter=e.target.value?isoToKey(e.target.value):null; renderSales(); });
  $("salesAll").addEventListener("click", ()=>{ salesFilter=null; $("salesDate").value=""; renderSales(); });
  $("exportCsv").addEventListener("click", exportCsv);

  // sincronização entre abas (cards/estoque ao vivo)
  window.addEventListener("storage", e=>{ if(e.key && e.key.indexOf("pdv:")===0) reloadFromStorage(); });

  // vendas: expandir
  $("salesList").addEventListener("click", e=>{
    const head=e.target.closest("[data-toggle]"); if(!head) return;
    head.closest(".sale").classList.toggle("open");
  });

  // teclado manual
  $("keypad").addEventListener("click", e=>{
    const b=e.target.closest("button"); if(!b) return;
    const k=b.dataset.k;
    if(k==="back") manualBuf=manualBuf.slice(0,-1);
    else if(k==="clear") manualBuf="";
    else if(manualBuf.length<14) manualBuf+=k;
    updateManual();
  });
  $("manualClose").addEventListener("click", closeManual);
  $("manualSearch").addEventListener("click", ()=>{
    if(!manualBuf){ return; }
    addByCode(manualBuf);
    closeManual();
    closeScanModal();
  });
  $("manualModal").addEventListener("click", e=>{ if(e.target.id==="manualModal") closeManual(); });

  // confirmação (sheet reutilizável)
  $("confirmYes").addEventListener("click", ()=>{ const cb=confirmCb; closeConfirm(); if(cb) cb(); });
  $("confirmNo").addEventListener("click", closeConfirm);
  $("confirmModal").addEventListener("click", e=>{ if(e.target.id==="confirmModal") closeConfirm(); });

  // Esc fecha qualquer modal aberto (acessibilidade)
  document.addEventListener("keydown", e=>{
    if(e.key!=="Escape") return;
    if($("confirmModal").classList.contains("show")){ closeConfirm(); return; }
    if($("scanModal").classList.contains("show")){ closeScanModal(); return; }
    ["payModal","receiptModal","manualModal","restockModal","cashModal"].forEach(id=>{ const m=$(id); if(m && m.classList.contains("show")) m.classList.remove("show"); });
  });

  // bloqueia gestos/zoom residuais
  document.addEventListener("gesturestart", e=>e.preventDefault());
  document.addEventListener("dblclick", e=>e.preventDefault(), {passive:false});
}

function switchTab(which){
  $("tabEstoque").classList.toggle("active",which==="estoque");
  $("tabVendas").classList.toggle("active",which==="vendas");
  $("tabUsuarios").classList.toggle("active",which==="usuarios");
  $("panelEstoque").classList.toggle("is-active",which==="estoque");
  $("panelVendas").classList.toggle("is-active",which==="vendas");
  $("panelUsuarios").classList.toggle("is-active",which==="usuarios");
  if(which==="estoque") renderStock();
  else if(which==="vendas"){ renderSales(); renderCashHist(); }
  else renderUsers();
  renderCards();
}

/* ---------- service worker (PWA: instalável e offline) ---------- */
if("serviceWorker" in navigator && location.protocol.indexOf("http")===0){
  window.addEventListener("load", ()=>{
    // "?v=" na URL do registro: o GitHub Pages não deixa marcar sw.js como
    // "sem cache", então o navegador às vezes reaproveita uma cópia em cache
    // HTTP na checagem de atualização e nunca percebe que o arquivo mudou.
    // Mudando a URL a cada versão, cada deploy vira uma URL nunca vista
    // antes — o navegador é obrigado a buscar na rede de verdade.
    navigator.serviceWorker.register("./sw.js?v="+APP_VERSION).then(reg=>{
      // procura atualização ao abrir e sempre que o app volta ao primeiro plano
      const check = ()=>{ reg.update().catch(()=>{}); };
      check();
      document.addEventListener("visibilitychange", ()=>{ if(!document.hidden) check(); });
    }).catch(()=>{});
  });
  // quando um SW novo assume o controle, recarrega uma vez para a versão
  // nova valer imediatamente (sem reload na primeira instalação e nunca
  // com venda em andamento — nesse caso ela vale na próxima abertura)
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", ()=>{
    if(!hadController){ hadController = true; return; }
    if(!state.cart.length) location.reload();
  });
}

/* ---------- start ---------- */
boot().catch(()=>{
  // mesmo com falha inesperada na carga, a interface precisa responder
  try{ wire(); }catch(e){}
  markStorageFailure();
});
