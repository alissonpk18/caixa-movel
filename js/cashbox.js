"use strict";
/* ================================================================
   CAIXA — adicionar ao estoque (operador autorizado)
   ================================================================ */
function openRestock(){
  if(!canAddStock(state.user)) return;
  $("rs_code").value=""; $("rs_qty").value=""; $("rs_exp").value="";
  $("rs_err").textContent=""; updateRestockFound();
  $("restockModal").classList.add("show");
  setTimeout(()=>{ try{ $("rs_code").focus(); }catch(e){} },120);
}
function closeRestock(){ $("restockModal").classList.remove("show"); }
function updateRestockFound(){
  const f=$("rs_found"); const code=$("rs_code").value.trim();
  if(!code){ f.textContent=""; f.classList.remove("bad"); return; }
  const p=findProduct(code);
  if(p){ f.textContent=p.name+" · estoque atual: "+p.qty+" un"+(p.exp?" · "+expText(p.exp):""); f.classList.remove("bad"); }
  else{ f.textContent="Código não cadastrado"; f.classList.add("bad"); }
}
function confirmRestock(){
  const err=$("rs_err");
  const code=$("rs_code").value.trim();
  const add=parseInt($("rs_qty").value,10);
  const p=findProduct(code);
  if(!p){ err.textContent="Produto não encontrado. Cadastro de novos produtos é feito pela gerência."; return; }
  if(isNaN(add)||add<=0){ err.textContent="Informe uma quantidade válida (maior que zero)."; return; }
  if(p.qty+add>QTY_MAX){ err.textContent="Limite de estoque excedido (máx. 1.000.000 un)."; return; }
  p.qty+=add;
  const exp=$("rs_exp").value;
  if(isIsoDate(exp)) p.exp=exp;   // registra a validade da mercadoria que entrou
  saveProducts();
  // ajuste relativo na nuvem (soma, nunca "define" — ver js/cloud.js)
  if(typeof cloudEnqueueStockDelta==="function") cloudEnqueueStockDelta(p.code, add);
  if($("gerente").classList.contains("is-active")) renderStock();
  closeRestock();
  setStatus("Estoque atualizado: "+p.name+" (+"+add+")","ok"); beep("ok");
  toast("✓ +"+add+" em "+p.name,"ok");
}

/* ================================================================
   CAIXA — abertura, sangria/reforço e fechamento com conferência
   ================================================================ */
const fmtDT=(iso)=>new Date(iso).toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"});
function openCashModal(){
  renderCashModal();
  $("cashModal").classList.add("show");
}
function closeCashModal(){ $("cashModal").classList.remove("show"); }
function renderCashModal(){
  const open=DB.cash.open;
  $("cashClosed").style.display = open ? "none" : "block";
  $("cashOpen").style.display   = open ? "block" : "none";
  $("cashClosing").style.display="none";
  $("cash_err1").textContent=""; $("cash_err2").textContent=""; $("cash_err3").textContent="";
  if(!open){ $("cash_float").value=""; return; }
  $("cash_mov").value="";
  const sess=sessionSales(open, DB.sales);
  const sum=salesSummary(sess);
  const cashTotal=round2(sess.reduce((s,x)=>s+((x.payment&&x.payment.method==="dinheiro")?x.total:0),0));
  const sang=round2(open.movements.filter(m=>m.type==="sangria").reduce((s,m)=>s+m.amount,0));
  const refo=round2(open.movements.filter(m=>m.type==="reforco").reduce((s,m)=>s+m.amount,0));
  const expected=cashExpected(open, DB.sales);
  $("cashInfo").textContent="Aberto em "+fmtDT(open.openedAt)+" por "+open.operator;
  $("cashSummary").innerHTML=
    `<div class="r-it"><span>Fundo de troco</span><span>${money(open.openingFloat)}</span></div>`+
    `<div class="r-it"><span>Vendas em dinheiro</span><span>${money(cashTotal)}</span></div>`+
    `<div class="r-it"><span>Reforços</span><span>${money(refo)}</span></div>`+
    `<div class="r-it"><span>Sangrias</span><span>−${money(sang)}</span></div>`+
    `<div class="r-total"><span>Esperado na gaveta</span><span>${money(expected)}</span></div>`+
    `<div class="r-it"><span>Vendas do turno (todas)</span><span>${sum.count} · ${money(sum.total)}</span></div>`;
}
function openCash(){
  const err=$("cash_err1");
  const raw=$("cash_float").value.trim();
  const v=raw?parseMoney(raw):0;
  if(isNaN(v)||v<0||v>PRICE_MAX){ err.textContent="Valor de fundo de troco inválido."; return; }
  DB.cash.open={ openedAt:new Date().toISOString(), operator:state.user?state.user.name:"—", openingFloat:round2(v), movements:[] };
  saveCash();
  renderCashModal();
  toast("✓ Caixa aberto — fundo "+money(v),"ok");
}
function cashMovement(type){
  const err=$("cash_err2");
  const open=DB.cash.open; if(!open) return;
  const v=parseMoney($("cash_mov").value);
  if(isNaN(v)||v<=0){ err.textContent="Informe um valor maior que zero."; return; }
  if(type==="sangria" && round2(v)>cashExpected(open, DB.sales)){
    err.textContent="Sangria maior que o dinheiro esperado na gaveta."; return;
  }
  open.movements.push({ type, amount:round2(v), ts:new Date().toISOString() });
  saveCash();
  renderCashModal();
  toast(type==="sangria"?("Sangria de "+money(v)+" registrada"):("✓ Reforço de "+money(v)),"ok");
}
function startCloseCash(){
  const open=DB.cash.open; if(!open) return;
  $("cashOpen").style.display="none";
  $("cashClosing").style.display="block";
  $("cash_counted").value=""; $("cash_err3").textContent="";
  $("cashExpectBox").innerHTML=
    `<div class="r-total"><span>Esperado na gaveta</span><span>${money(cashExpected(open, DB.sales))}</span></div>`;
}
function confirmCloseCash(){
  const err=$("cash_err3");
  const open=DB.cash.open; if(!open) return;
  const raw=$("cash_counted").value.trim();
  const counted=raw?parseMoney(raw):NaN;
  if(isNaN(counted)||counted<0){ err.textContent="Informe o valor contado na gaveta."; return; }
  const closedAt=new Date().toISOString();
  const expected=cashExpected(open, DB.sales);
  const sess=sessionSales({...open, closedAt}, DB.sales);
  const sum=salesSummary(sess);
  const diff=round2(counted-expected);
  DB.cash.history.unshift({ ...open, closedAt, expected, counted:round2(counted), diff, salesTotal:sum.total, salesCount:sum.count });
  DB.cash.history=DB.cash.history.slice(0,60); // guarda os últimos fechamentos, sem crescer sem limite
  DB.cash.open=null;
  saveCash();
  renderCashModal();
  closeCashModal();
  const msg = diff===0 ? "caixa bateu certinho" : (diff>0 ? "sobra de "+money(diff) : "falta de "+money(-diff));
  toast("✓ Caixa fechado — "+msg, diff<0?"bad":"ok");
  if($("gerente").classList.contains("is-active")) renderCashHist();
}
function renderCashHist(){
  const el=$("cashHistList"); if(!el) return;
  const list=DB.cash.history;
  if(!list.length){ el.innerHTML='<div class="empty-list">Nenhum fechamento de caixa registrado.</div>'; return; }
  el.innerHTML=list.slice(0,15).map(h=>{
    const diffTxt = h.diff===0 ? "OK" : (h.diff>0?"+":"−")+money(Math.abs(h.diff)).replace("R$ ","");
    const cls = h.diff===0 ? "" : (h.diff>0 ? "soon" : "expired");
    return `<div class="ss-row" style="margin-bottom:6px">
      <span><b>${fmtDT(h.openedAt)} → ${fmtDT(h.closedAt)}</b> · ${escapeHtml(h.operator)} · ${h.salesCount} vendas</span>
      <span style="text-align:right">${money(h.expected)} <span class="explabel ${cls}" style="margin-left:4px">${escapeHtml(diffTxt)}</span></span>
    </div>`;
  }).join("");
}

