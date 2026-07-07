"use strict";
/* ================================================================
   GERÊNCIA — cards, estoque, vendas
   ================================================================ */
function renderManager(){
  if($("lowThreshold")) $("lowThreshold").value=settings.lowStock;
  if($("expThreshold")) $("expThreshold").value=settings.expWarnDays;
  if($("salesDate")) $("salesDate").value = salesFilter ? keyToIso(salesFilter) : "";
  if($("pix_key")){ $("pix_key").value=settings.pixKey||""; $("pix_name").value=settings.pixName||""; $("pix_city").value=settings.pixCity||""; }
  renderCards(); renderStock(); renderSales(); renderUsers(); renderCashHist();
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
/* atualiza o selo e as bordas de uma linha do estoque conforme a validade */
function refreshExpRow(row,p){
  const ec=expClass(p.exp);
  row.classList.remove("soon","expired");
  if(ec) row.classList.add(ec);
  const lbl=row.querySelector(".explabel");
  if(lbl){ lbl.textContent=expText(p.exp); lbl.className="explabel "+ec; }
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
  const list=q ? DB.products.filter(p=>p.name.toLowerCase().includes(q)||p.code.includes(q)) : DB.products;
  if(!list.length){ el.innerHTML='<div class="empty-list">Nenhum produto encontrado.</div>'; return; }
  const avgMap=dailyAvgMap(DB.sales,14); // ritmo de venda dos últimos 14 dias
  el.innerHTML=list.map(p=>{
    const ec=expClass(p.exp);
    const left=daysOfStock(p.qty, avgMap[p.code]||0);
    const leftDays=Math.max(0,Math.ceil(left));
    const leftTag=(isFinite(left)&&left<=14)
      ? ` <span class="explabel ${left<=3?"expired":"soon"}">📦 estoque p/ ~${leftDays} ${leftDays===1?"dia":"dias"}</span>`
      : "";
    return `
    <div class="prow ${p.qty<=settings.lowStock?"low":""} ${ec}" data-code="${escapeHtml(p.code)}">
      <div class="top">
        <input class="pname-input" type="text" data-f="name" value="${escapeHtml(p.name)}" />
        <button class="prow-del" data-act="delprod" title="Excluir produto">✕</button>
      </div>
      <div class="code-line stockbadge">${p.qty} un · ${escapeHtml(p.code)}</div>
      <div><span class="explabel ${ec}">${escapeHtml(expText(p.exp))}</span>${leftTag}</div>
      <div class="edits">
        <div class="e">
          <label>Preço (R$)</label>
          <input type="tel" inputmode="decimal" data-f="price" value="${p.price.toFixed(2)}" />
        </div>
        <div class="e">
          <label>Custo (R$)</label>
          <input type="tel" inputmode="decimal" data-f="cost" value="${typeof p.cost==="number"?p.cost.toFixed(2):""}" placeholder="—" />
        </div>
        <div class="e">
          <label>Estoque</label>
          <input type="tel" inputmode="numeric" data-f="qty" value="${p.qty}" />
        </div>
      </div>
      <div class="exp-edit">
        <label>Validade</label>
        <input type="date" data-f="exp" value="${p.exp||""}" />
      </div>
      <div style="text-align:right;margin-top:6px"><span class="saved">✓ salvo</span></div>
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
    const payLabel=s.payment ? (PAY_LABEL[s.payment.method]||s.payment.method||"") : "";
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
    const pay=s.payment ? (PAY_LABEL[s.payment.method]||s.payment.method||"") : "";
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
  // se um operador está logado, mantém o botão de estoque coerente com a permissão atual
  if(state.user && state.user.role==="operador" && $("operador").classList.contains("is-active")){
    const fresh=DB.users.find(x=>x.username===state.user.username);
    if(!fresh){ toast("Seu acesso foi removido","bad"); logout(); return; }
    state.user=fresh; $("restockBtn").style.display = canAddStock(fresh) ? "" : "none";
  }
}

function addProduct(){
  const code=$("np_code").value.trim();
  const name=$("np_name").value.trim();
  const price=parseMoney($("np_price").value);
  const qty=parseInt($("np_qty").value,10);
  const costRaw=$("np_cost").value.trim();
  const exp=$("np_exp").value||null;
  const err=$("np_err");

  if(!/^\d{6,14}$/.test(code)){ err.textContent="Código inválido (use 6 a 14 dígitos)."; return; }
  if(findProduct(code)){ err.textContent="Já existe um produto com esse código."; return; }
  if(!name){ err.textContent="Informe o nome do produto."; return; }
  if(isNaN(price)||price<=0||price>PRICE_MAX){ err.textContent="Preço inválido (até R$ 999.999,99)."; return; }
  if(isNaN(qty)||qty<0||qty>QTY_MAX){ err.textContent="Quantidade inválida (0 a 1.000.000)."; return; }
  let cost=null;
  if(costRaw){
    cost=parseMoney(costRaw);
    if(isNaN(cost)||cost<0||cost>PRICE_MAX){ err.textContent="Custo inválido."; return; }
    cost=round2(cost);
  }

  DB.products.unshift({ code, name, price:round2(price), qty, exp:isIsoDate(exp)?exp:null, cost });
  saveProducts();
  ["np_code","np_name","np_price","np_qty","np_cost","np_exp"].forEach(id=>$(id).value="");
  err.textContent="";
  renderStock();
  toast("✓ "+name+" cadastrado","ok");
}

