"use strict";
/* ================================================================
   CARRINHO / VENDA
   ================================================================ */
function findProduct(code){ return DB.products.find(p=>p.code===String(code).trim()); }

function addByCode(rawCode){
  const code=String(rawCode).trim();
  if(!code) return;
  const prod=findProduct(code);
  if(!prod){ setStatus("Código não cadastrado: "+code,"bad"); beep("bad"); return; }

  const inCart = state.cart.find(i=>i.code===code);
  const have = inCart ? inCart.qty : 0;
  if(prod.qty - have <= 0){ setStatus("Estoque esgotado: "+prod.name,"bad"); beep("bad"); return; }

  if(inCart){ inCart.qty++; }
  else{ state.cart.push({ code:prod.code, name:prod.name, price:prod.price, qty:1 }); }

  setStatus("Adicionado: "+prod.name,"ok"); beep("ok");
  renderCart(true);
}

function changeQty(code,delta){
  const it=state.cart.find(i=>i.code===code); if(!it) return;
  if(delta>0){
    const prod=findProduct(code);
    if(prod && it.qty>=prod.qty){ setStatus("Sem estoque para mais "+it.name,"bad"); beep("bad"); return; }
  }
  it.qty+=delta;
  if(it.qty<=0) state.cart=state.cart.filter(i=>i.code!==code);
  renderCart();
}
function removeItem(code){ state.cart=state.cart.filter(i=>i.code!==code); renderCart(); }
function clearCart(){ state.cart=[]; renderCart(); }
function cartTotal(){ return round2(state.cart.reduce((s,i)=>s+i.price*i.qty,0)); }
function cartCount(){ return state.cart.reduce((s,i)=>s+i.qty,0); }

function renderCart(flash){
  const list=$("cartList"), empty=$("cartEmpty");
  const has=state.cart.length>0;
  empty.style.display = has ? "none" : "flex";
  list.innerHTML = state.cart.map(i=>`
    <div class="line">
      <div class="info">
        <div class="name">${escapeHtml(i.name)}</div>
        <div class="unit">${money(i.price)} cada</div>
      </div>
      <div class="qtybox">
        <button data-act="minus" data-code="${escapeHtml(i.code)}">−</button>
        <div class="q">${i.qty}</div>
        <button data-act="plus" data-code="${escapeHtml(i.code)}">+</button>
      </div>
      <div class="lt">${money(i.price*i.qty)}</div>
      <button class="del" data-act="del" data-code="${escapeHtml(i.code)}">✕</button>
    </div>`).join("");

  const total=cartTotal();
  $("cartTotal").textContent=money(total);
  $("itemCount").textContent=cartCount()+(cartCount()===1?" item":" itens");
  $("finalizeBtn").disabled=!has;
  $("cancelBtn").disabled=!has;

  if(flash && !reduceMotion){
    const t=$("cartTotal"); t.classList.add("flash");
    setTimeout(()=>t.classList.remove("flash"),300);
    $("cartScroll").scrollTop=$("cartScroll").scrollHeight;
  }
}

function finalizeSale(payment){
  if(!state.cart.length) return null;
  const sale={
    id:uid(), ts:new Date().toISOString(),
    operator: state.user ? state.user.name : "—",
    items: state.cart.map(i=>({code:i.code,name:i.name,price:i.price,qty:i.qty})),
    total: cartTotal(),
    payment: payment || { method:"—", received:cartTotal(), change:0 }
  };
  // baixa de estoque
  state.cart.forEach(i=>{ const p=findProduct(i.code); if(p){ p.qty=Math.max(0,p.qty-i.qty); } });
  DB.sales.unshift(sale);
  saveProducts(); saveSales();

  const v=sale.total;
  clearCart();
  setStatus("Venda registrada • "+money(v),"ok"); beep("ok");
  toast("✓ Venda registrada — "+money(v),"ok");
  return sale;
}

/* ---------- pagamento + troco ---------- */
const PAY_LABEL = { dinheiro:"Dinheiro", cartao:"Cartão", pix:"Pix" };
function openPay(){
  if(!state.cart.length) return;
  state.pay={ method:"dinheiro" };
  $("payTotal").textContent=money(cartTotal());
  $("payMethods").querySelectorAll("button").forEach(b=>b.classList.toggle("active", b.dataset.m==="dinheiro"));
  $("payReceived").value="";
  $("payCashWrap").style.display="block";
  $("payPixWrap").style.display="none";
  updateChange();
  $("payModal").classList.add("show");
  setTimeout(()=>{ try{ $("payReceived").focus(); }catch(e){} },120);
}
function selectMethod(m){
  state.pay.method=m;
  $("payMethods").querySelectorAll("button").forEach(b=>b.classList.toggle("active", b.dataset.m===m));
  $("payCashWrap").style.display = m==="dinheiro" ? "block" : "none";
  $("payPixWrap").style.display = m==="pix" ? "block" : "none";
  if(m==="pix") renderPixPay();
}

/* ---------- Pix na finalização (BR Code estático com o valor da venda) ---------- */
function renderPixPay(){
  const qrEl=$("pixQr"), codeEl=$("pixCode"), err=$("pixPayErr"), copy=$("pixCopyBtn");
  qrEl.innerHTML=""; codeEl.textContent=""; err.textContent=""; copy.style.display="none";
  if(!settings.pixKey || !settings.pixName){
    err.textContent="Chave Pix não configurada — peça à gerência (aba Vendas).";
    return;
  }
  const payload=pixPayload({ key:settings.pixKey, name:settings.pixName, city:settings.pixCity, amount:cartTotal() });
  if(!payload){ err.textContent="Configuração Pix inválida — revise na gerência."; return; }
  state.pay.pixCode=payload;
  codeEl.textContent=payload;
  copy.style.display="";
  if(typeof qrcode==="function"){
    try{
      const qr=qrcode(0,"M"); qr.addData(payload); qr.make();
      qrEl.innerHTML=qr.createSvgTag({cellSize:3,margin:3,scalable:true});
      const svg=qrEl.querySelector("svg");
      if(svg){ svg.style.width="min(52vw,210px)"; svg.style.height="auto"; svg.style.background="#fff"; svg.style.borderRadius="10px"; }
    }catch(e){ /* sem QR: o copia e cola continua disponível */ }
  }
}
async function copyPixCode(){
  const code=state.pay.pixCode||"";
  if(!code) return;
  let ok=false;
  try{ await navigator.clipboard.writeText(code); ok=true; }catch(e){}
  if(!ok){
    // fallback para navegadores sem clipboard API em contexto não seguro
    try{
      const ta=document.createElement("textarea");
      ta.value=code; ta.style.position="fixed"; ta.style.opacity="0";
      document.body.appendChild(ta); ta.select();
      ok=document.execCommand("copy");
      document.body.removeChild(ta);
    }catch(e){}
  }
  toast(ok?"✓ Código Pix copiado":"Não foi possível copiar — selecione o texto", ok?"ok":"bad");
}
function savePixConfig(){
  const err=$("pix_err");
  const key=$("pix_key").value.trim();
  const name=$("pix_name").value.trim();
  const city=$("pix_city").value.trim();
  if(!key && !name && !city){
    // limpa a configuração (desativa o Pix na finalização)
    settings.pixKey=""; settings.pixName=""; settings.pixCity="";
    saveSettings(); err.textContent="";
    toast("Configuração Pix removida","bad");
    return;
  }
  if(!key || key.length>77){ err.textContent="Informe a chave Pix (até 77 caracteres)."; return; }
  if(!name){ err.textContent="Informe o nome do recebedor (como no banco)."; return; }
  if(!pixPayload({key, name, city, amount:1})){ err.textContent="Dados inválidos para o BR Code."; return; }
  settings.pixKey=key; settings.pixName=name; settings.pixCity=city;
  saveSettings();
  err.textContent="";
  toast("✓ Pix configurado","ok");
}
function updateChange(){
  const rec=parseMoney($("payReceived").value)||0;
  $("payChange").textContent=money(Math.max(0, round2(rec-cartTotal())));
}
function confirmPay(){
  const total=cartTotal();
  let received=total, change=0;
  if(state.pay.method==="dinheiro"){
    received=round2(parseMoney($("payReceived").value)||0);
    if(received < total){ toast("Valor recebido menor que o total","bad"); beep("bad"); return; }
    change=round2(received-total);
  }
  const sale=finalizeSale({ method:state.pay.method, received, change });
  $("payModal").classList.remove("show");
  if(sale) showReceipt(sale);
}

/* ---------- comprovante ---------- */
function showReceipt(sale){
  state.lastSale=sale;
  const t=new Date(sale.ts).toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
  const pay=sale.payment||{method:"—"};
  const methodLabel=PAY_LABEL[pay.method]||pay.method||"—";
  const lines=sale.items.map(i=>`<div class="r-it"><span>${escapeHtml(i.name)} ×${i.qty}</span><span>${money(i.price*i.qty)}</span></div>`).join("");
  let payExtra="";
  if(pay.method==="dinheiro"){
    payExtra=`<div class="r-it"><span>Recebido</span><span>${money(pay.received)}</span></div>`
            +`<div class="r-it"><span>Troco</span><span>${money(pay.change)}</span></div>`;
  }
  $("receiptBox").innerHTML=`
    <div class="r-head">
      <div class="r-title">PDV · Caixa Rápido</div>
      <div class="r-sub">${t}</div>
      <div class="r-sub">Operador: ${escapeHtml(sale.operator)}</div>
    </div>
    <div class="r-items">${lines}</div>
    <div class="r-total"><span>TOTAL</span><span>${money(sale.total)}</span></div>
    <div class="r-pay"><div class="r-it"><span>Pagamento</span><span>${escapeHtml(methodLabel)}</span></div>${payExtra}</div>
    <div class="r-foot">Obrigado pela preferência!</div>`;
  $("receiptModal").classList.add("show");
}
function printReceipt(){
  const html=$("receiptBox").innerHTML;
  const w=window.open("","_blank","width=380,height=640");
  if(!w){ toast("Permita pop-ups para imprimir","bad"); return; }
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Comprovante</title><style>
    body{font-family:ui-monospace,Menlo,Consolas,monospace;padding:16px;color:#000;font-size:13px}
    .r-head{text-align:center;margin-bottom:10px}.r-title{font-weight:800;font-size:15px;font-family:sans-serif}
    .r-sub{font-size:11.5px;color:#444}
    .r-it{display:flex;justify-content:space-between;padding:2px 0;gap:8px}
    .r-it span:first-child{font-family:sans-serif}
    .r-total{display:flex;justify-content:space-between;font-weight:800;font-size:16px;border-top:1px dashed #000;border-bottom:1px dashed #000;padding:8px 0;margin:8px 0}
    .r-foot{text-align:center;margin-top:12px;font-size:11.5px;color:#444}
  </style></head><body>${html}<script>window.onload=function(){window.print();}<\/script></body></html>`);
  w.document.close();
}

/* ---------- comprovante em texto (para enviar por WhatsApp etc.) ---------- */
function receiptText(sale){
  const t=new Date(sale.ts).toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
  const pay=sale.payment||{method:"—"};
  const label=PAY_LABEL[pay.method]||pay.method||"—";
  const lines=sale.items.map(i=>i.name+" x"+i.qty+"  "+money(i.price*i.qty)).join("\n");
  let extra="";
  if(pay.method==="dinheiro") extra="\nRecebido: "+money(pay.received)+"\nTroco: "+money(pay.change);
  return "PDV · Caixa Rápido\n"+t+"\nOperador: "+sale.operator+
    "\n────────────────\n"+lines+
    "\n────────────────\nTOTAL "+money(sale.total)+
    "\nPagamento: "+label+extra+
    "\n\nObrigado pela preferência!";
}
async function shareReceipt(){
  const sale=state.lastSale;
  if(!sale) return;
  const text=receiptText(sale);
  if(navigator.share){
    try{ await navigator.share({ text }); return; }
    catch(e){ if(e && e.name==="AbortError") return; } // usuário cancelou
  }
  try{ await navigator.clipboard.writeText(text); toast("✓ Comprovante copiado — cole onde quiser","ok"); }
  catch(e){ toast("Não foi possível compartilhar neste navegador","bad"); }
}

