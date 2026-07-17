"use strict";
/* ================================================================
   GERÊNCIA — estoque, vendas (os KPIs do dia moraram para Indicadores)
   ================================================================ */
function renderManager(){
  if($("lowThreshold")) $("lowThreshold").value=settings.lowStock;
  if($("expThreshold")) $("expThreshold").value=settings.expWarnDays;
  if($("salesDate")) $("salesDate").value = salesFilter ? keyToIso(salesFilter) : "";
  if($("pix_key")){ $("pix_key").value=settings.pixKey||""; $("pix_name").value=settings.pixName||""; $("pix_city").value=settings.pixCity||""; }
  renderStock(); renderSales(); renderUsers(); renderCashHist();
}

function filteredSales(){
  if(!salesFilter) return DB.sales.slice();
  return DB.sales.filter(s=>todayKey(new Date(s.ts))===salesFilter);
}

function renderCards(){
  const tk=todayKey();
  const today=DB.sales.filter(s=>todayKey(new Date(s.ts))===tk);
  const revenue=today.reduce((s,x)=>s+x.total,0);
  const items=today.reduce((s,x)=>s+x.items.reduce((a,i)=>a+i.qty,0),0);
  $("cardRevenue").textContent=money(revenue);
  $("cardCount").textContent=today.length;
  $("cardItems").textContent=items;
}

/* ---------- validade ---------- */
function expClass(iso){
  const d=daysUntilExp(iso);
  if(d===null) return "";
  if(d<0) return "expired";
  if(d<=settings.expWarnDays) return "soon";
  return "";
}
function isoToBr(iso){ if(!iso) return ""; const a=iso.split("-"); return a[2]+"/"+a[1]+"/"+a[0]; }
function expText(iso){
  const d=daysUntilExp(iso);
  if(d===null) return "Sem validade";
  const br=isoToBr(iso);
  if(d<0)   return "⚠ Vencido há "+(-d)+" "+(-d===1?"dia":"dias")+" ("+br+")";
  if(d===0) return "⚠ Vence hoje ("+br+")";
  if(d<=settings.expWarnDays) return "⏰ Vence em "+d+" "+(d===1?"dia":"dias")+" ("+br+")";
  return "Validade: "+br;
}
function renderExpAlert(){
  const el=$("expAlert"); if(!el) return;
  const expired=DB.products.filter(p=>expClass(p.exp)==="expired").length;
  const soon=DB.products.filter(p=>expClass(p.exp)==="soon").length;
  if(!expired && !soon){ el.className="exp-alert"; el.textContent=""; return; }
  const parts=[];
  if(expired) parts.push(expired+" "+(expired===1?"produto vencido":"produtos vencidos"));
  if(soon)    parts.push(soon+" a vencer");
  el.textContent=(expired?"⚠ ":"⏰ ")+parts.join(" · ");
  el.className="exp-alert show "+(expired?"bad":"warn");
}

function renderStock(){
  const el=$("prodList");
  renderExpAlert();
  if(!DB.products.length){ el.innerHTML='<div class="empty-list">Nenhum produto cadastrado.</div>'; return; }
  const q=prodQuery.trim().toLowerCase();
  let list=q ? DB.products.filter(p=>p.name.toLowerCase().includes(q)||p.code.includes(q)) : DB.products.slice();
  if(prodFilter==="low")      list=list.filter(p=>p.qty<=settings.lowStock);
  else if(prodFilter==="exp") list=list.filter(p=>{ const c=expClass(p.exp); return c==="soon"||c==="expired"; });
  if(!list.length){ el.innerHTML='<div class="empty-list">Nenhum produto encontrado.</div>'; return; }
  const [sortKey,sortDir]=prodSort.split("-");
  const dir=sortDir==="desc"?-1:1;
  list=list.slice().sort((a,b)=>{
    let av,bv;
    if(sortKey==="name")       { av=a.name.toLowerCase(); bv=b.name.toLowerCase(); }
    else if(sortKey==="qty")   { av=a.qty; bv=b.qty; }
    else if(sortKey==="price") { av=a.price; bv=b.price; }
    else if(sortKey==="exp")   { av=a.exp||"9999-99-99"; bv=b.exp||"9999-99-99"; }
    if(av<bv) return -1*dir;
    if(av>bv) return  1*dir;
    return 0;
  });
  const avgMap=dailyAvgMap(DB.sales,14); // ritmo de venda dos últimos 14 dias
  el.innerHTML=list.map(p=>{
    const ec=expClass(p.exp);
    const left=daysOfStock(p.qty, avgMap[p.code]||0);
    const leftDays=Math.max(0,Math.ceil(left));
    const leftTag=(isFinite(left)&&left<=14)
      ? ` <span class="explabel ${left<=3?"expired":"soon"}">📦 estoque p/ ~${leftDays} ${leftDays===1?"dia":"dias"}</span>`
      : "";
    return `
    <div class="prow ${p.qty<=settings.lowStock?"low":""} ${ec}" data-code="${escapeHtml(p.code)}" role="button" tabindex="0" aria-label="Editar ${escapeHtml(p.name)}">
      <div class="top">
        <div class="pname">${escapeHtml(p.name)}</div>
        <div class="pprice">${money(p.price)}</div>
      </div>
      <div class="code-line">${escapeHtml(p.code)}</div>
      <div><span class="qtybadge">${p.qty} un</span><span class="explabel ${ec}">${escapeHtml(expText(p.exp))}</span>${leftTag}</div>
    </div>`;
  }).join("");
}

function renderSales(){
  const el=$("salesList");
  const list=filteredSales();
  const sum=salesSummary(list);
  if($("salesSummary")){
    $("salesSummary").innerHTML=`<div class="ss-row"><span>${sum.count} ${sum.count===1?"venda":"vendas"} · ${sum.items} ${sum.items===1?"item":"itens"} · ticket médio ${money(sum.avgTicket)}</span><b>${money(sum.total)}</b></div>`;
  }
  renderAbc(list);
  if(!list.length){ el.innerHTML='<div class="empty-list">Nenhuma venda no período.</div>'; return; }
  const showDate=!salesFilter;
  el.innerHTML=list.map(s=>{
    const d=new Date(s.ts);
    const t=d.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});
    const dd=showDate ? d.toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"})+" " : "";
    const n=s.items.reduce((a,i)=>a+i.qty,0);
    const payLabel=s.payment ? paymentLabel(s.payment) : "";
    return `<div class="sale" data-id="${escapeHtml(s.id)}">
      <div class="head" data-toggle="${escapeHtml(s.id)}">
        <div class="meta"><b>${dd}${t}</b> · ${n} ${n===1?"item":"itens"} · ${escapeHtml(s.operator)}${payLabel?" · "+escapeHtml(payLabel):""}</div>
        <div class="amt">${money(s.total)}</div>
      </div>
      <div class="items">
        ${s.items.map(i=>`<div class="it"><span>${escapeHtml(i.name)} ×${i.qty}</span><span>${money(i.price*i.qty)}</span></div>`).join("")}
      </div>
    </div>`;
  }).join("");
}

/* ---------- curva ABC do período filtrado ---------- */
function renderAbc(list){
  const el=$("abcList"); if(!el) return;
  const costBy={};
  DB.products.forEach(p=>{ if(typeof p.cost==="number") costBy[p.code]=p.cost; });
  const rows=abcAnalysis(list||filteredSales(), costBy).slice(0,10);
  if(!rows.length){ el.innerHTML='<div class="empty-list">Sem vendas no período.</div>'; return; }
  el.innerHTML=rows.map(r=>`
    <div class="ss-row" style="margin-bottom:6px">
      <span><span class="urole ${r.cls==="A"?"ger":""}" style="margin:0 6px 0 0">${r.cls}</span>${escapeHtml(r.name)} · ${r.qty} un${r.profit!=null?" · lucro "+money(r.profit):""}</span>
      <b>${money(r.revenue)}</b>
    </div>`).join("");
}

/* ---------- exportar CSV ---------- */
function exportCsv(){
  const list=filteredSales();
  if(!list.length){ toast("Nada para exportar","bad"); return; }
  const rows=[["Data/Hora","Operador","Pagamento","Produto","Codigo","Qtd","Preco Unit","Subtotal","Total Venda"]];
  list.forEach(s=>{
    const dt=new Date(s.ts).toLocaleString("pt-BR");
    const pay=s.payment ? paymentLabel(s.payment) : "";
    s.items.forEach(i=>{
      rows.push([dt,s.operator,pay,i.name,i.code,i.qty,csvNum(i.price),csvNum(i.price*i.qty),csvNum(s.total)]);
    });
  });
  const csv=rows.map(r=>r.map(csvCell).join(";")).join("\r\n");
  const blob=new Blob(["﻿"+csv],{type:"text/csv;charset=utf-8;"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url; a.download="vendas-"+(salesFilter?keyToIso(salesFilter):"todas")+".csv";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast("✓ CSV exportado","ok");
}

/* ---------- sincronização entre abas (cards ao vivo) ---------- */
async function reloadFromStorage(){
  if(hasArtifactStorage || hasLocalStorage){
    const p=sanitizeProducts(await sget("pdv:products"));
    const s=sanitizeSales(await sget("pdv:sales"));
    const u=sanitizeUsers(await sget("pdv:users"));
    const c=sanitizeCash(await sget("pdv:cash"));
    applySettings(await sget("pdv:settings"));
    if(p) DB.products=p;
    if(s) DB.sales=s;
    if(c) DB.cash=c;
    if(u && u.length){ DB.users=u; ensureManagerAccess(); }
  }
  if($("gerente").classList.contains("is-active")) renderManager();
  if($("indicadores").classList.contains("is-active")) renderDashboard();
  // se alguém está no caixa (operador ou gerência), mantém o botão de estoque coerente com a permissão atual
  if(state.user && $("operador").classList.contains("is-active")){
    const fresh=DB.users.find(x=>x.username===state.user.username);
    if(!fresh){ toast("Seu acesso foi removido","bad"); logout(); return; }
    state.user=fresh;
    $("restockBtn").style.display = canAddStock(fresh) ? "" : "none";
    $("backToGerBtn").style.display = fresh.role==="gerente" ? "" : "none";
  }
}

/* ================================================================
   MODAL DE PRODUTO — criar e editar usam a mesma sheet; a lista do
   estoque é só leitura e o toque no card injeta o produto aqui.
   ================================================================ */
let prodModalCode=null; // null = novo produto; senão, código do produto em edição

function openProdModal(code){
  const p = code ? findProduct(code) : null;
  prodModalCode = p ? p.code : null;
  $("prodModalTitle").textContent = p ? "Editar produto" : "Novo produto";
  $("prodModalSub").textContent = p ? "Altere os dados e salve. O código de barras não muda." : "Preencha os dados do produto.";
  $("addProdBtn").textContent = p ? "Salvar alterações" : "Cadastrar produto";
  $("prodDeleteBtn").style.display = p ? "" : "none";
  $("np_code").value = p ? p.code : "";
  $("np_code").readOnly = !!p;
  $("np_name").value = p ? p.name : "";
  $("np_price").value = p ? p.price.toFixed(2) : "";
  $("np_qty").value = p ? String(p.qty) : "";
  $("np_cost").value = (p && typeof p.cost==="number") ? p.cost.toFixed(2) : "";
  $("np_exp").value = (p && p.exp) ? p.exp : "";
  $("np_err").textContent="";
  $("prodModal").classList.add("show");
}
function closeProdModal(){ $("prodModal").classList.remove("show"); prodModalCode=null; }

/* lê e valida o formulário; devolve null (com mensagem no #np_err) se inválido */
function readProdForm(){
  const err=$("np_err");
  const code=$("np_code").value.trim();
  const name=$("np_name").value.trim();
  const price=parseMoney($("np_price").value);
  const qty=parseInt($("np_qty").value,10);
  const costRaw=$("np_cost").value.trim();
  const exp=$("np_exp").value||null;

  if(!/^\d{6,14}$/.test(code)){ err.textContent="Código inválido (use 6 a 14 dígitos)."; return null; }
  if(!name){ err.textContent="Informe o nome do produto."; return null; }
  if(isNaN(price)||price<=0||price>PRICE_MAX){ err.textContent="Preço inválido (até R$ 999.999,99)."; return null; }
  if(isNaN(qty)||qty<0||qty>QTY_MAX){ err.textContent="Quantidade inválida (0 a 1.000.000)."; return null; }
  let cost=null;
  if(costRaw){
    cost=parseMoney(costRaw);
    if(isNaN(cost)||cost<0||cost>PRICE_MAX){ err.textContent="Custo inválido."; return null; }
    cost=round2(cost);
  }
  err.textContent="";
  return { code, name, price:round2(price), qty, exp:isIsoDate(exp)?exp:null, cost };
}

function saveProdModal(){
  const data=readProdForm(); if(!data) return;
  const err=$("np_err");
  if(prodModalCode){
    const p=findProduct(prodModalCode);
    if(!p){ err.textContent="Produto não encontrado — a lista pode ter mudado em outro aparelho."; return; }
    const qtyChanged = p.qty!==data.qty;
    p.name=data.name; p.price=data.price; p.cost=data.cost; p.qty=data.qty; p.exp=data.exp;
    // correção manual de estoque: define o valor absoluto na nuvem (ver js/cloud.js)
    if(qtyChanged && typeof cloudEnqueueStockSet==="function") cloudEnqueueStockSet(p.code, p.qty);
    saveProducts(); renderStock(); closeProdModal();
    toast("✓ "+p.name+" atualizado","ok");
  }else{
    if(findProduct(data.code)){ err.textContent="Já existe um produto com esse código."; return; }
    DB.products.unshift(data);
    saveProducts(); renderStock(); closeProdModal();
    toast("✓ "+data.name+" cadastrado","ok");
  }
}

function deleteProdFromModal(){
  if(!prodModalCode) return;
  const p=findProduct(prodModalCode); if(!p) return;
  askConfirm("Excluir produto","Remover \""+p.name+"\" do estoque? Esta ação não pode ser desfeita.",()=>{
    DB.products=DB.products.filter(x=>x.code!==p.code);
    saveProducts(); renderStock(); closeProdModal();
    toast("Produto removido","bad");
  },"Excluir");
}

