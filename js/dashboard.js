"use strict";
/* ================================================================
   INDICADORES — dashboard gerencial (gráficos e análises de decisão)
   ================================================================ */
let dashDays = 30; // janela do filtro no topo da tela; 0 = tudo

const WEEKDAY_NAMES = ["Domingo","Segunda","Terça","Quarta","Quinta","Sexta","Sábado"];
const WEEKDAY_SHORT = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
const PAY_NAME = { dinheiro:"Dinheiro", cartao:"Cartão", pix:"Pix" };

function enterDashboard(){
  show("indicadores");
  renderDashboard();
}

function dashSalesInWindow(){
  if(!dashDays) return DB.sales.slice();
  const cutoff = Date.now() - dashDays*86400000;
  return DB.sales.filter(s=>{ const t=Date.parse(s.ts); return isFinite(t) && t>=cutoff; });
}

/* quantos dias plotar na tendência quando o filtro é "Tudo" (limitado p/ caber na tela) */
function dashSeriesSpan(list){
  if(dashDays) return dashDays;
  let minT = Date.now();
  list.forEach(s=>{ const t=Date.parse(s.ts); if(isFinite(t) && t<minT) minT=t; });
  const days = Math.ceil((Date.now()-minT)/86400000)+1;
  return Math.min(Math.max(days,1), 120);
}

/* barra horizontal única — usada em ranking de vendedores, pagamento e produtos */
function barRowHtml(label, value, max, valueText, isPeak){
  const pct = max>0 ? Math.max(3, Math.round(value/max*100)) : 0;
  return `<div class="barrow${isPeak?" peak":""}">
    <div class="barlabel" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
    <div class="bartrack"><div class="barfill" style="width:${pct}%"></div></div>
    <div class="barval">${valueText}</div>
  </div>`;
}

function weekdayBarsHtml(byWeekday){
  const max = Math.max(0, ...byWeekday.map(b=>b.revenue));
  const peakIdx = byWeekday.reduce((best,b,i)=>b.revenue>byWeekday[best].revenue?i:best, 0);
  return `<div class="barlist">` + byWeekday.map((b,i)=>
    barRowHtml(WEEKDAY_SHORT[b.day], b.revenue, max, money(b.revenue), i===peakIdx && b.revenue>0)
  ).join("") + `</div>`;
}

function operatorBarsHtml(byOperator){
  if(!byOperator.length) return '<div class="empty-list">Sem vendas no período.</div>';
  const rows = byOperator.slice(0,8);
  const max = Math.max(0, ...rows.map(r=>r.revenue));
  return `<div class="barlist">` + rows.map((r,i)=>
    barRowHtml(r.operator, r.revenue, max, money(r.revenue), i===0)
  ).join("") + `</div>`;
}

function paymentBarsHtml(byPayment){
  if(!byPayment.length) return '<div class="empty-list">Sem vendas no período.</div>';
  const max = Math.max(0, ...byPayment.map(r=>r.revenue));
  return `<div class="barlist">` + byPayment.map((r,i)=>
    barRowHtml(PAY_NAME[r.method]||r.method, r.revenue, max, money(r.revenue), i===0)
  ).join("") + `</div>`;
}

function productBarsHtml(rows){
  if(!rows.length) return '<div class="empty-list">Sem vendas no período.</div>';
  const max = Math.max(0, ...rows.map(r=>r.revenue));
  return `<div class="barlist">` + rows.map((r,i)=>
    barRowHtml(r.name, r.revenue, max, money(r.revenue), i===0)
  ).join("") + `</div>`;
}

/* rampa sequencial de um único hue (a cor da marca), do claro (--bg) ao escuro (--brand) */
function heatColor(t){
  const c0=[226,229,234], c1=[45,78,216]; // --line → --brand: rampa sequencial de um único tom
  const r=Math.round(c0[0]+(c1[0]-c0[0])*t);
  const g=Math.round(c0[1]+(c1[1]-c0[1])*t);
  const b=Math.round(c0[2]+(c1[2]-c0[2])*t);
  return `rgb(${r},${g},${b})`;
}

function hourHeatHtml(byHour){
  const max = Math.max(0, ...byHour.map(b=>b.revenue));
  const peakIdx = byHour.reduce((best,b,i)=>b.revenue>byHour[best].revenue?i:best, 0);
  const cells = byHour.map((b,i)=>{
    const t = max>0 ? b.revenue/max : 0;
    const label = String(i).padStart(2,"0")+"h — "+money(b.revenue);
    return `<div class="heatcell${i===peakIdx && b.revenue>0?" peak":""}" style="background:${heatColor(t)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></div>`;
  }).join("");
  const marks = [0,4,8,12,16,20].map(h=>`<span>${String(h).padStart(2,"0")}h</span>`).join("");
  return `<div class="heatstrip">${cells}</div><div class="heat-labels">${marks}</div>`;
}

function trendChartHtml(series){
  const max = Math.max(0, ...series.map(s=>s.revenue));
  const todayKey_ = dateKey(new Date());
  const bars = series.map(s=>{
    const h = max>0 ? Math.max(2, Math.round(s.revenue/max*100)) : 2;
    const label = s.date.toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"})+" — "+money(s.revenue);
    return `<div class="bar${s.key===todayKey_?" today":""}" style="height:${h}%" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></div>`;
  }).join("");
  const first = series[0], last = series[series.length-1];
  const fmt = d => d.toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"});
  return `<div class="trendchart">${bars}</div>
    <div class="trend-labels"><span>${fmt(first.date)}</span><span>${fmt(last.date)}</span></div>`;
}

function basketHtml(pairs){
  return pairs.map(p=>`
    <div class="basket-row">
      <span class="bp-names">${escapeHtml(p.nameA)} <span class="bp-plus">+</span> ${escapeHtml(p.nameB)}</span>
      <span class="bp-count">${p.count}×</span>
    </div>`).join("");
}

function renderDashboard(){
  const el = $("dashContent"); if(!el) return;
  const list = dashSalesInWindow();
  if(!list.length){
    el.innerHTML = '<div class="empty-list">Sem vendas no período selecionado.</div>';
    return;
  }
  const sum = salesSummary(list);
  const byHour = salesByHour(list);
  const byWeekday = salesByWeekday(list);
  const byOperator = salesByOperator(list);
  const byPayment = paymentBreakdown(list);
  const series = dailyRevenueSeries(list, dashSeriesSpan(list), null);
  const costBy = {}; DB.products.forEach(p=>{ if(typeof p.cost==="number") costBy[p.code]=p.cost; });
  const abc = abcAnalysis(list, costBy);
  const pairs = basketPairs(list, 8).filter(p=>p.count>=2);

  const peakHour = byHour.reduce((a,b)=>b.revenue>a.revenue?b:a, byHour[0]);
  const peakWeekday = byWeekday.reduce((a,b)=>b.revenue>a.revenue?b:a, byWeekday[0]);
  const topOperator = byOperator[0];

  el.innerHTML = `
    <div class="dash-kpis">
      <div class="stat wide"><div class="k">Faturamento no período</div><div class="v">${money(sum.total)}</div></div>
      <div class="stat"><div class="k">Vendas</div><div class="v">${sum.count}</div></div>
      <div class="stat"><div class="k">Ticket médio</div><div class="v">${money(sum.avgTicket)}</div></div>
      <div class="stat"><div class="k">Melhor horário</div><div class="v">${String(peakHour.hour).padStart(2,"0")}h</div></div>
      <div class="stat"><div class="k">Melhor dia</div><div class="v">${WEEKDAY_SHORT[peakWeekday.day]}</div></div>
      ${topOperator?`<div class="stat wide"><div class="k">Vendedor destaque</div><div class="v" style="font-size:19px">${escapeHtml(topOperator.operator)}<small style="display:inline;font-size:12.5px;color:var(--muted);font-family:var(--sans);font-weight:600"> — ${money(topOperator.revenue)} em ${topOperator.count} ${topOperator.count===1?"venda":"vendas"}</small></div></div>`:""}
    </div>

    <div class="dash-section">
      <div class="sectitle">Faturamento por dia</div>
      ${trendChartHtml(series)}
    </div>

    <div class="dash-section">
      <div class="sectitle">Vendas por horário do dia</div>
      <div class="dash-note">Pico às ${String(peakHour.hour).padStart(2,"0")}h · ${money(peakHour.revenue)}</div>
      ${hourHeatHtml(byHour)}
    </div>

    <div class="dash-section">
      <div class="sectitle">Vendas por dia da semana</div>
      <div class="dash-note">Melhor dia: ${WEEKDAY_NAMES[peakWeekday.day]} · ${money(peakWeekday.revenue)}</div>
      ${weekdayBarsHtml(byWeekday)}
    </div>

    <div class="dash-section">
      <div class="sectitle">Ranking de vendedores</div>
      ${operatorBarsHtml(byOperator)}
    </div>

    <div class="dash-section">
      <div class="sectitle">Formas de pagamento</div>
      ${paymentBarsHtml(byPayment)}
    </div>

    <div class="dash-section">
      <div class="sectitle">Top produtos por faturamento</div>
      ${productBarsHtml(abc.slice(0,8))}
    </div>

    <div class="dash-section">
      <div class="sectitle">Produtos comprados juntos</div>
      <div class="dash-note">Combos frequentes — úteis para promoções cruzadas e organização das prateleiras</div>
      ${pairs.length ? basketHtml(pairs) : '<div class="empty-list">Ainda não há combinações recorrentes suficientes.</div>'}
    </div>
  `;
}
