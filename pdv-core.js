/* PDV · Caixa Rápido — núcleo de regras de negócio (sem DOM).
   Carregado pelo app como window.PDV e pelos testes unitários via Node
   (module.exports). Toda função aqui é pura: recebe dados, devolve dados. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PDV = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const QTY_MAX = 1000000;      // teto de estoque por produto
  const PRICE_MAX = 999999.99;  // teto de preço/custo unitário

  /* ---------- dinheiro ---------- */
  /* arredonda para centavos — dinheiro nunca compara/acumula float cru */
  const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

  /* aceita "1.234,56", "5,49", "5.49", "R$ 5,49" → número. Vírgula = decimal (padrão BR). */
  function parseMoney(str) {
    let s = String(str == null ? "" : str).trim().replace(/(R\$|\s)/gi, "");
    if (!s) return NaN;
    if (s.indexOf(",") > -1) s = s.replace(/\./g, "").replace(/,/g, ".");
    if (!/^-?\d*\.?\d+$/.test(s)) return NaN;
    return parseFloat(s);
  }

  /* ---------- texto / CSV ---------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function csvCell(v) { const s = String(v); return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  /* decimal com vírgula: é o que o Excel/LibreOffice pt-BR espera em CSV com ";" */
  function csvNum(v) { return Number(v).toFixed(2).replace(".", ","); }

  /* ---------- datas ---------- */
  function isIsoDate(v) { return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v); }
  /* chave interna de dia (2026-6-30) ↔ input date (2026-06-30) */
  function keyToIso(key) { const a = key.split("-"); return a[0] + "-" + String(a[1]).padStart(2, "0") + "-" + String(a[2]).padStart(2, "0"); }
  function isoToKey(iso) { const a = iso.split("-").map(Number); return a[0] + "-" + a[1] + "-" + a[2]; }
  function dateKey(d) { return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
  /* dias até vencer: negativo = vencido, 0 = vence hoje, null = sem validade */
  function daysUntilExp(iso, now) {
    if (!iso) return null;
    const a = String(iso).split("-").map(Number);
    if (a.length !== 3 || a.some(isNaN)) return null;
    const exp = new Date(a[0], a[1] - 1, a[2]);
    const n = now ? new Date(now) : new Date();
    const today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    return Math.round((exp - today) / 86400000);
  }

  /* ---------- saneamento dos dados carregados ----------
     O storage pode conter dados de versões antigas ou corrompidos.
     Tudo que entra no app passa por aqui para que um registro inválido
     nunca derrube a interface. */
  function sanitizeSettings(st) {
    const out = {};
    if (st && typeof st === "object") {
      if (typeof st.lowStock === "number" && isFinite(st.lowStock) && st.lowStock >= 0) out.lowStock = Math.floor(st.lowStock);
      if (typeof st.expWarnDays === "number" && isFinite(st.expWarnDays) && st.expWarnDays >= 0) out.expWarnDays = Math.floor(st.expWarnDays);
      if (typeof st.pixKey === "string") out.pixKey = st.pixKey.trim().slice(0, 77);
      if (typeof st.pixName === "string") out.pixName = st.pixName.trim().slice(0, 25);
      if (typeof st.pixCity === "string") out.pixCity = st.pixCity.trim().slice(0, 15);
      if (typeof st.storeName === "string") out.storeName = st.storeName.trim().slice(0, 60);
    }
    return out;
  }
  function sanitizeUsers(list) {
    if (!Array.isArray(list)) return null;
    const seen = new Set(), out = [];
    list.forEach(u => {
      if (!u || typeof u !== "object") return;
      const username = String(u.username || "").trim().toLowerCase();
      if (!username || seen.has(username)) return;
      if (typeof u.password !== "string" && typeof u.passHash !== "string") return;
      seen.add(username);
      const clean = {
        username, role: u.role === "gerente" ? "gerente" : "operador",
        name: String(u.name || username), canAddStock: u.canAddStock === true
      };
      if (typeof u.passHash === "string" && u.passHash) clean.passHash = u.passHash;
      else clean.password = u.password;
      out.push(clean);
    });
    return out;
  }
  function sanitizeProducts(list) {
    if (!Array.isArray(list)) return null;
    const seen = new Set(), out = [];
    list.forEach(p => {
      if (!p || typeof p !== "object") return;
      const code = String(p.code == null ? "" : p.code).trim();
      const price = Number(p.price), qty = Math.floor(Number(p.qty));
      if (!code || seen.has(code) || !isFinite(price) || price < 0 || !isFinite(qty) || qty < 0) return;
      seen.add(code);
      const cost = Number(p.cost);
      out.push({
        code, name: String(p.name || code), price: round2(Math.min(price, PRICE_MAX)),
        qty: Math.min(qty, QTY_MAX), exp: isIsoDate(p.exp) ? p.exp : null,
        cost: (isFinite(cost) && cost >= 0) ? round2(Math.min(cost, PRICE_MAX)) : null
      });
    });
    return out;
  }
  function sanitizeSales(list, genId) {
    if (!Array.isArray(list)) return null;
    const mkId = typeof genId === "function" ? genId : (() => "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));
    return list
      .filter(s => s && typeof s === "object" && typeof s.ts === "string" &&
        !isNaN(Date.parse(s.ts)) && Array.isArray(s.items) && isFinite(Number(s.total)))
      .map(s => ({
        id: String(s.id || mkId()), ts: s.ts, operator: String(s.operator || "—"), total: round2(Number(s.total)),
        items: s.items.filter(i => i && typeof i === "object").map(i => ({
          code: String(i.code == null ? "" : i.code), name: String(i.name || "?"),
          price: Number(i.price) || 0, qty: Number(i.qty) || 0
        })),
        payment: s.payment && typeof s.payment === "object"
          ? { method: String(s.payment.method || "—"), received: Number(s.payment.received) || 0, change: Number(s.payment.change) || 0 }
          : null
      }));
  }
  /* sessão de caixa {open, history} — mesma filosofia dos demais sanitizers */
  function sanitizeCash(c) {
    if (!c || typeof c !== "object") return null;
    const num = v => { const n = Number(v); return isFinite(n) && n >= 0 ? round2(n) : 0; };
    const numAny = v => { const n = Number(v); return isFinite(n) ? round2(n) : 0; };
    const movs = list => Array.isArray(list) ? list
      .filter(m => m && (m.type === "sangria" || m.type === "reforco") && isFinite(Number(m.amount)) && Number(m.amount) > 0)
      .map(m => ({ type: m.type, amount: round2(Number(m.amount)), ts: (typeof m.ts === "string" && !isNaN(Date.parse(m.ts))) ? m.ts : "" })) : [];
    const sess = s => {
      if (!s || typeof s !== "object" || typeof s.openedAt !== "string" || isNaN(Date.parse(s.openedAt))) return null;
      return { openedAt: s.openedAt, operator: String(s.operator || "—"), openingFloat: num(s.openingFloat), movements: movs(s.movements) };
    };
    const history = Array.isArray(c.history) ? c.history.map(h => {
      const b = sess(h);
      if (!b || typeof h.closedAt !== "string" || isNaN(Date.parse(h.closedAt))) return null;
      return {
        ...b, closedAt: h.closedAt, expected: numAny(h.expected), counted: numAny(h.counted), diff: numAny(h.diff),
        salesTotal: numAny(h.salesTotal), salesCount: Math.max(0, Math.floor(Number(h.salesCount) || 0))
      };
    }).filter(Boolean) : [];
    return { open: sess(c.open), history };
  }

  /* ---------- Pix (BR Code / EMV-MPM, Manual de Iniciação do Pix, BCB) ---------- */
  function stripAccents(s) { return String(s == null ? "" : s).normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
  /* nome/cidade do BR Code: ASCII visível, sem acentos, com limite de tamanho */
  function pixText(s, max) { return stripAccents(s).replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }
  /* CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — checksum obrigatório do payload */
  function crc16(str) {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i) << 8;
      for (let j = 0; j < 8; j++) { crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1); crc &= 0xFFFF; }
    }
    return crc.toString(16).toUpperCase().padStart(4, "0");
  }
  /* payload "copia e cola"/QR estático com valor. Retorna null se a config é inválida. */
  function pixPayload(cfg) {
    cfg = cfg || {};
    const key = String(cfg.key || "").trim();
    const name = pixText(cfg.name, 25);
    const city = pixText(cfg.city, 15) || "BRASIL";
    if (!key || key.length > 77 || !name) return null;
    const amount = Number(cfg.amount);
    const txid = (String(cfg.txid || "***").replace(/[^A-Za-z0-9*]/g, "").slice(0, 25)) || "***";
    const tlv = (id, v) => id + String(v.length).padStart(2, "0") + v;
    const acct = tlv("00", "br.gov.bcb.pix") + tlv("01", key);
    let p = tlv("00", "01") + tlv("26", acct) + tlv("52", "0000") + tlv("53", "986");
    if (isFinite(amount) && amount > 0) p += tlv("54", round2(amount).toFixed(2));
    p += tlv("58", "BR") + tlv("59", name) + tlv("60", city) + tlv("62", tlv("05", txid)) + "6304";
    return p + crc16(p);
  }

  /* ---------- caixa (gaveta de dinheiro) ---------- */
  /* vendas dentro da janela da sessão (da abertura até o fechamento, se houver) */
  function sessionSales(session, sales) {
    if (!session) return [];
    const start = Date.parse(session.openedAt);
    const end = session.closedAt ? Date.parse(session.closedAt) : Infinity;
    return (sales || []).filter(s => {
      const t = Date.parse(s && s.ts);
      return isFinite(t) && t >= start && t <= end;
    });
  }
  /* dinheiro esperado na gaveta: fundo + vendas em dinheiro + reforços − sangrias */
  function cashExpected(session, sales) {
    if (!session) return 0;
    let cash = 0;
    sessionSales(session, sales).forEach(s => {
      if (s.payment && s.payment.method === "dinheiro") cash += Number(s.total) || 0;
    });
    let mov = 0;
    (session.movements || []).forEach(m => { mov += m.type === "reforco" ? m.amount : -m.amount; });
    return round2(session.openingFloat + cash + mov);
  }

  /* ---------- relatórios ---------- */
  function salesSummary(list) {
    const arr = Array.isArray(list) ? list : [];
    const count = arr.length;
    const total = round2(arr.reduce((s, x) => s + (Number(x.total) || 0), 0));
    const items = arr.reduce((s, x) => s + (Array.isArray(x.items) ? x.items.reduce((a, i) => a + (Number(i.qty) || 0), 0) : 0), 0);
    return { count, total, items, avgTicket: count ? round2(total / count) : 0 };
  }
  /* curva ABC por receita: A = itens que compõem os primeiros 80% do faturamento,
     B = até 95%, C = o resto. Lucro calculado quando o custo do produto é conhecido. */
  function abcAnalysis(list, costByCode) {
    const map = Object.create(null);
    (Array.isArray(list) ? list : []).forEach(s => (Array.isArray(s.items) ? s.items : []).forEach(i => {
      const k = String(i.code == null ? "" : i.code); if (!k) return;
      const e = map[k] || (map[k] = { code: k, name: String(i.name || k), qty: 0, revenue: 0, profit: null });
      const q = Number(i.qty) || 0, pr = Number(i.price) || 0;
      e.qty += q; e.revenue += pr * q;
      const c = costByCode ? costByCode[k] : undefined;
      if (typeof c === "number" && isFinite(c)) e.profit = (e.profit || 0) + (pr - c) * q;
    }));
    const rows = Object.values(map).map(e => ({ ...e, revenue: round2(e.revenue), profit: e.profit == null ? null : round2(e.profit) }));
    rows.sort((a, b) => b.revenue - a.revenue);
    const total = rows.reduce((s, r) => s + r.revenue, 0);
    let acc = 0;
    rows.forEach(r => {
      const before = total ? acc / total : 1;
      r.share = total ? round2(r.revenue / total * 100) / 100 : 0;
      r.cls = before < 0.80 ? "A" : before < 0.95 ? "B" : "C";
      acc += r.revenue;
    });
    return rows;
  }
  /* média de unidades vendidas por dia (últimos N dias) por código de produto */
  function dailyAvgMap(sales, days, now) {
    days = days || 14;
    const nowT = now ? new Date(now).getTime() : Date.now();
    const cutoff = nowT - days * 86400000;
    const map = Object.create(null);
    (Array.isArray(sales) ? sales : []).forEach(s => {
      const t = Date.parse(s && s.ts);
      if (!isFinite(t) || t < cutoff || t > nowT + 86400000) return;
      (Array.isArray(s.items) ? s.items : []).forEach(i => {
        const k = String(i.code == null ? "" : i.code); if (!k) return;
        map[k] = (map[k] || 0) + (Number(i.qty) || 0);
      });
    });
    Object.keys(map).forEach(k => { map[k] = map[k] / days; });
    return map;
  }
  /* dias de estoque restantes no ritmo atual (Infinity = sem consumo medido) */
  function daysOfStock(qty, avgPerDay) { return avgPerDay > 0 ? qty / avgPerDay : Infinity; }

  /* ---------- indicadores gerenciais ---------- */
  /* ranking de vendedores por faturamento (quem mais vendeu) */
  function salesByOperator(list) {
    const map = Object.create(null);
    (Array.isArray(list) ? list : []).forEach(s => {
      const k = String(s.operator || "—");
      const e = map[k] || (map[k] = { operator: k, count: 0, revenue: 0, items: 0 });
      e.count += 1;
      e.revenue += Number(s.total) || 0;
      e.items += (Array.isArray(s.items) ? s.items : []).reduce((a, i) => a + (Number(i.qty) || 0), 0);
    });
    const rows = Object.values(map).map(e => ({ ...e, revenue: round2(e.revenue) }));
    rows.sort((a, b) => b.revenue - a.revenue);
    return rows;
  }

  /* vendas por hora do dia (0-23, hora local do aparelho — mesma base usada nos recibos) */
  function salesByHour(list) {
    const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, revenue: 0 }));
    (Array.isArray(list) ? list : []).forEach(s => {
      const t = Date.parse(s && s.ts); if (!isFinite(t)) return;
      const b = buckets[new Date(t).getHours()];
      b.count += 1; b.revenue += Number(s.total) || 0;
    });
    buckets.forEach(b => { b.revenue = round2(b.revenue); });
    return buckets;
  }

  /* vendas por dia da semana (0=domingo … 6=sábado, hora local) */
  function salesByWeekday(list) {
    const buckets = Array.from({ length: 7 }, (_, d) => ({ day: d, count: 0, revenue: 0 }));
    (Array.isArray(list) ? list : []).forEach(s => {
      const t = Date.parse(s && s.ts); if (!isFinite(t)) return;
      const b = buckets[new Date(t).getDay()];
      b.count += 1; b.revenue += Number(s.total) || 0;
    });
    buckets.forEach(b => { b.revenue = round2(b.revenue); });
    return buckets;
  }

  /* faturamento por forma de pagamento */
  function paymentBreakdown(list) {
    const map = Object.create(null);
    (Array.isArray(list) ? list : []).forEach(s => {
      const k = (s.payment && s.payment.method) ? String(s.payment.method) : "—";
      const e = map[k] || (map[k] = { method: k, count: 0, revenue: 0 });
      e.count += 1; e.revenue += Number(s.total) || 0;
    });
    const rows = Object.values(map).map(e => ({ ...e, revenue: round2(e.revenue) }));
    rows.sort((a, b) => b.revenue - a.revenue);
    return rows;
  }

  /* série diária de faturamento dos últimos N dias (para gráfico de tendência) */
  function dailyRevenueSeries(list, days, now) {
    days = days || 14;
    const end = now ? new Date(now) : new Date();
    end.setHours(0, 0, 0, 0);
    const map = Object.create(null);
    (Array.isArray(list) ? list : []).forEach(s => {
      const t = Date.parse(s && s.ts); if (!isFinite(t)) return;
      const d = new Date(t); d.setHours(0, 0, 0, 0);
      const diff = Math.round((end - d) / 86400000);
      if (diff < 0 || diff >= days) return;
      const k = dateKey(d);
      map[k] = (map[k] || 0) + (Number(s.total) || 0);
    });
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(end); d.setDate(d.getDate() - i);
      const k = dateKey(d);
      out.push({ key: k, date: d, revenue: round2(map[k] || 0) });
    }
    return out;
  }

  /* pares de produtos comprados juntos na mesma venda (cesta de compras),
     ordenados do mais frequente ao menos frequente */
  function basketPairs(list, limit) {
    const map = Object.create(null);
    (Array.isArray(list) ? list : []).forEach(s => {
      const items = Array.isArray(s.items) ? s.items : [];
      const names = Object.create(null);
      items.forEach(i => { if (i && i.code != null) names[String(i.code)] = String(i.name || i.code); });
      const codes = Array.from(new Set(Object.keys(names)));
      for (let a = 0; a < codes.length; a++) {
        for (let b = a + 1; b < codes.length; b++) {
          const x = codes[a] < codes[b] ? codes[a] : codes[b];
          const y = codes[a] < codes[b] ? codes[b] : codes[a];
          const k = x + "|" + y;
          const e = map[k] || (map[k] = { a: x, b: y, nameA: names[x], nameB: names[y], count: 0 });
          e.count += 1;
        }
      }
    });
    const rows = Object.values(map);
    rows.sort((a, b) => b.count - a.count);
    return typeof limit === "number" ? rows.slice(0, limit) : rows;
  }

  /* ---------- indicadores de estoque ---------- */
  /* valor investido (custo) e valor de venda (preço) de todo o estoque atual */
  function stockValueSummary(products) {
    const arr = Array.isArray(products) ? products : [];
    let costSum = 0, retailSum = 0, units = 0;
    arr.forEach(p => {
      const qty = Number(p.qty) || 0;
      const price = Number(p.price) || 0;
      units += qty;
      if (typeof p.cost === "number" && isFinite(p.cost)) costSum += qty * p.cost;
      retailSum += qty * price;
    });
    const margin = costSum > 0 ? round2((retailSum - costSum) / costSum * 100) : null;
    return { costValue: round2(costSum), retailValue: round2(retailSum), units, count: arr.length, margin };
  }
  /* rupturas (qty=0) e estoque baixo (0<qty<=lowStock) */
  function stockAlertCounts(products, lowStock) {
    const arr = Array.isArray(products) ? products : [];
    const threshold = Number(lowStock) || 0;
    let outOfStock = 0, low = 0;
    arr.forEach(p => {
      const qty = Number(p.qty) || 0;
      if (qty <= 0) outOfStock++;
      else if (qty <= threshold) low++;
    });
    return { outOfStock, lowStock: low };
  }
  /* giro aproximado no período: unidades vendidas / unidades em estoque hoje */
  function stockTurnover(unitsSold, unitsInStock) {
    return unitsInStock > 0 ? round2(unitsSold / unitsInStock) : 0;
  }
  /* ranking por valor parado em estoque (qty × custo; usa preço quando o custo é desconhecido) */
  function stockValueRanking(products) {
    const arr = Array.isArray(products) ? products : [];
    const rows = arr.map(p => {
      const qty = Number(p.qty) || 0;
      const unit = typeof p.cost === "number" && isFinite(p.cost) ? p.cost : (Number(p.price) || 0);
      return { code: p.code, name: String(p.name || p.code), qty, value: round2(qty * unit) };
    }).filter(r => r.qty > 0 && r.value > 0);
    rows.sort((a, b) => b.value - a.value);
    return rows;
  }
  /* produtos com estoque > 0 mas sem nenhuma venda no período medido por avgMap (dailyAvgMap) */
  function deadStock(products, avgMap) {
    const arr = Array.isArray(products) ? products : [];
    return arr.filter(p => (Number(p.qty) || 0) > 0 && !(avgMap && avgMap[p.code] > 0))
      .map(p => {
        const qty = Number(p.qty) || 0;
        const unit = typeof p.cost === "number" && isFinite(p.cost) ? p.cost : (Number(p.price) || 0);
        return { code: p.code, name: String(p.name || p.code), qty, value: round2(qty * unit) };
      })
      .sort((a, b) => b.value - a.value);
  }
  /* produtos com cobertura crítica: estoque acaba em até maxDays no ritmo atual de vendas */
  function criticalCoverage(products, avgMap, maxDays) {
    const arr = Array.isArray(products) ? products : [];
    const rows = [];
    arr.forEach(p => {
      const qty = Number(p.qty) || 0;
      const avg = (avgMap && avgMap[p.code]) || 0;
      if (avg <= 0) return;
      const days = daysOfStock(qty, avg);
      if (isFinite(days) && days <= maxDays) rows.push({ code: p.code, name: String(p.name || p.code), qty, days: Math.max(0, Math.round(days)) });
    });
    rows.sort((a, b) => a.days - b.days);
    return rows;
  }

  return {
    QTY_MAX, PRICE_MAX,
    round2, parseMoney, escapeHtml, csvCell, csvNum,
    isIsoDate, keyToIso, isoToKey, dateKey, daysUntilExp,
    sanitizeSettings, sanitizeUsers, sanitizeProducts, sanitizeSales, sanitizeCash,
    stripAccents, pixText, crc16, pixPayload,
    sessionSales, cashExpected,
    salesSummary, abcAnalysis, dailyAvgMap, daysOfStock,
    salesByOperator, salesByHour, salesByWeekday, paymentBreakdown, dailyRevenueSeries, basketPairs,
    stockValueSummary, stockAlertCounts, stockTurnover, stockValueRanking, deadStock, criticalCoverage
  };
});
