/* Testes unitários do núcleo de regras (pdv-core.js).
   Rodar com: npm test  (node --test tests/) */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PDV = require("../pdv-core.js");

/* ---------- dinheiro ---------- */
test("round2 elimina resíduo binário de ponto flutuante", () => {
  assert.equal(PDV.round2(5.49 * 3), 16.47);
  assert.equal(PDV.round2(0.1 + 0.2), 0.3);
  assert.equal(PDV.round2(16.47 - 16.47), 0);
  assert.equal(PDV.round2(-1.005), -1); // arredonda em direção consistente
});

test("parseMoney aceita formatos BR e rejeita lixo", () => {
  assert.equal(PDV.parseMoney("1.234,56"), 1234.56);
  assert.equal(PDV.parseMoney("5,49"), 5.49);
  assert.equal(PDV.parseMoney("5.49"), 5.49);
  assert.equal(PDV.parseMoney("R$ 5,49"), 5.49);
  assert.equal(PDV.parseMoney("  10  "), 10);
  assert.equal(PDV.parseMoney("-3,50"), -3.5);
  assert.ok(Number.isNaN(PDV.parseMoney("")));
  assert.ok(Number.isNaN(PDV.parseMoney(null)));
  assert.ok(Number.isNaN(PDV.parseMoney("abc")));
  assert.ok(Number.isNaN(PDV.parseMoney("12,34,56")));
  assert.ok(Number.isNaN(PDV.parseMoney("1.2.3")));
});

/* ---------- texto / CSV ---------- */
test("escapeHtml neutraliza os cinco caracteres perigosos", () => {
  assert.equal(PDV.escapeHtml(`<b a="1" b='2'>&`), "&lt;b a=&quot;1&quot; b=&#39;2&#39;&gt;&amp;");
  assert.equal(PDV.escapeHtml(123), "123");
});

test("csvCell cita células com ; aspas e quebras de linha", () => {
  assert.equal(PDV.csvCell("simples"), "simples");
  assert.equal(PDV.csvCell("a;b"), '"a;b"');
  assert.equal(PDV.csvCell('diz "oi"'), '"diz ""oi"""');
  assert.equal(PDV.csvCell("linha\nnova"), '"linha\nnova"');
});

test("csvNum usa vírgula decimal (padrão Excel pt-BR)", () => {
  assert.equal(PDV.csvNum(16.47), "16,47");
  assert.equal(PDV.csvNum(5.5), "5,50");
  assert.equal(PDV.csvNum(0), "0,00");
});

/* ---------- datas ---------- */
test("keyToIso/isoToKey são inversas", () => {
  assert.equal(PDV.keyToIso("2026-7-4"), "2026-07-04");
  assert.equal(PDV.isoToKey("2026-07-04"), "2026-7-4");
  assert.equal(PDV.isoToKey(PDV.keyToIso("2026-12-31")), "2026-12-31");
});

test("dateKey gera a chave local do dia", () => {
  assert.equal(PDV.dateKey(new Date(2026, 6, 4)), "2026-7-4");
});

test("daysUntilExp: passado, hoje, futuro, nulo e inválido", () => {
  const now = new Date(2026, 6, 4); // 04/07/2026
  assert.equal(PDV.daysUntilExp("2026-07-04", now), 0);
  assert.equal(PDV.daysUntilExp("2026-07-10", now), 6);
  assert.equal(PDV.daysUntilExp("2026-06-30", now), -4);
  assert.equal(PDV.daysUntilExp(null, now), null);
  assert.equal(PDV.daysUntilExp("", now), null);
  assert.equal(PDV.daysUntilExp("não-é-data", now), null);
});

test("isIsoDate valida o formato YYYY-MM-DD", () => {
  assert.ok(PDV.isIsoDate("2026-07-04"));
  assert.ok(!PDV.isIsoDate("2026-7-4"));
  assert.ok(!PDV.isIsoDate("04/07/2026"));
  assert.ok(!PDV.isIsoDate(20260704));
  assert.ok(!PDV.isIsoDate(null));
});

/* ---------- sanitizers ---------- */
test("sanitizeSettings mantém só campos válidos", () => {
  assert.deepEqual(PDV.sanitizeSettings(null), {});
  assert.deepEqual(PDV.sanitizeSettings("x"), {});
  assert.deepEqual(PDV.sanitizeSettings({ lowStock: -5, expWarnDays: "x" }), {});
  assert.deepEqual(PDV.sanitizeSettings({ lowStock: 7.9, expWarnDays: 10 }), { lowStock: 7, expWarnDays: 10 });
  const s = PDV.sanitizeSettings({ pixKey: "  chave@x.com  ", pixName: "Loja", pixCity: "SP" });
  assert.equal(s.pixKey, "chave@x.com");
  assert.equal(PDV.sanitizeSettings({ pixKey: "a".repeat(100) }).pixKey.length, 77);
});

test("sanitizeUsers: dedup, papéis coagidos, credencial obrigatória", () => {
  assert.equal(PDV.sanitizeUsers(null), null);
  assert.equal(PDV.sanitizeUsers("lixo"), null);
  const out = PDV.sanitizeUsers([
    { username: " Ana ", password: "1234", role: "chefe", name: "" },
    { username: "ana", password: "outra" },              // duplicata (case/trim)
    { username: "bia", passHash: "ff00", role: "gerente", canAddStock: "sim" },
    { username: "semcred" },                              // sem senha nem hash
    null, "x", 42
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { username: "ana", role: "operador", name: "ana", canAddStock: false, password: "1234" });
  assert.equal(out[1].passHash, "ff00");
  assert.equal(out[1].role, "gerente");
  assert.equal(out[1].canAddStock, false); // "sim" não é true
});

test("sanitizeProducts: inválidos caem, tetos aplicados, custo opcional", () => {
  assert.equal(PDV.sanitizeProducts({}), null);
  const out = PDV.sanitizeProducts([
    { code: "111111", name: "OK", price: 1.5, qty: 3.9, cost: 0.8 },
    { code: "111111", name: "dup", price: 2, qty: 1 },
    { code: null, price: 1, qty: 1 },
    { code: "222222", price: -1, qty: 1 },
    { code: "333333", price: 1, qty: -1 },
    { code: "444444", price: 99999999, qty: 99999999, exp: "2027-01-01", cost: -5 },
    "lixo", null
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { code: "111111", name: "OK", price: 1.5, qty: 3, exp: null, cost: 0.8 });
  assert.equal(out[1].price, PDV.PRICE_MAX);
  assert.equal(out[1].qty, PDV.QTY_MAX);
  assert.equal(out[1].exp, "2027-01-01");
  assert.equal(out[1].cost, null); // custo negativo vira null
});

test("sanitizeSales: filtra malformados, coage itens e pagamento", () => {
  const out = PDV.sanitizeSales([
    { ts: "2026-07-04T10:00:00Z", total: "16.47", items: [{ code: 111, name: "", price: "5.49", qty: "3" }, null], payment: { method: "dinheiro", received: "20", change: "3.53" } },
    { ts: "não-é-data", total: 1, items: [] },
    { ts: "2026-07-04T11:00:00Z", total: NaN, items: [] },
    { ts: "2026-07-04T12:00:00Z", total: 5, items: "x" },
    null
  ], () => "fixo");
  assert.equal(out.length, 1);
  const s = out[0];
  assert.equal(s.id, "fixo");
  assert.equal(s.total, 16.47);
  assert.deepEqual(s.items, [{ code: "111", name: "?", price: 5.49, qty: 3 }]);
  assert.deepEqual(s.payment, { method: "dinheiro", received: 20, change: 3.53 });
});

test("sanitizeCash: sessão aberta, movimentos e histórico", () => {
  assert.equal(PDV.sanitizeCash(null), null);
  const out = PDV.sanitizeCash({
    open: { openedAt: "2026-07-04T08:00:00Z", operator: 7, openingFloat: "50", movements: [
      { type: "sangria", amount: 20 }, { type: "roubo", amount: 5 }, { type: "reforco", amount: -1 }, null
    ]},
    history: [
      { openedAt: "2026-07-03T08:00:00Z", closedAt: "2026-07-03T18:00:00Z", openingFloat: 10, expected: 100, counted: 98, diff: -2, salesTotal: 90, salesCount: "4" },
      { openedAt: "inválido", closedAt: "2026-07-02T18:00:00Z" },
      { openedAt: "2026-07-01T08:00:00Z" } // sem closedAt
    ]
  });
  assert.equal(out.open.openingFloat, 50);
  assert.equal(out.open.operator, "7");
  assert.equal(out.open.movements.length, 1);
  assert.equal(out.open.movements[0].type, "sangria");
  assert.equal(out.history.length, 1);
  assert.equal(out.history[0].diff, -2);
  assert.equal(out.history[0].salesCount, 4);
});

/* ---------- Pix / BR Code ---------- */
test("crc16 bate com o vetor conhecido CCITT-FALSE", () => {
  assert.equal(PDV.crc16("123456789"), "29B1");
});

test("stripAccents e pixText normalizam para ASCII", () => {
  assert.equal(PDV.stripAccents("Ação São João"), "Acao Sao Joao");
  assert.equal(PDV.pixText("  Padaria   do  Zé  ", 25), "Padaria do Ze");
  assert.equal(PDV.pixText("Nome muito grande que passa do limite", 25).length, 25);
});

test("pixPayload monta BR Code válido com valor", () => {
  const p = PDV.pixPayload({ key: "loja@exemplo.com", name: "Padaria do Zé", city: "São Paulo", amount: 16.47 });
  assert.ok(p, "payload não pode ser null");
  assert.ok(p.startsWith("000201"), "começa com payload format 01");
  assert.ok(p.includes("br.gov.bcb.pix"), "tem o GUI do Pix");
  assert.ok(p.includes("540516.47"), "valor com tag 54, tamanho 05, ponto decimal");
  assert.ok(p.includes("5913Padaria do Ze"), "nome sem acento com tamanho certo");
  assert.ok(p.includes("6009Sao Paulo"), "cidade sem acento");
  assert.ok(p.includes("5303986"), "moeda BRL (986)");
  // CRC final confere: recalcula sobre o corpo + "6304"
  const body = p.slice(0, -4);
  assert.equal(p.slice(-4), PDV.crc16(body));
});

test("pixPayload sem valor omite a tag 54; config inválida retorna null", () => {
  const p = PDV.pixPayload({ key: "x@y.z", name: "Loja" });
  assert.ok(p && !p.includes("5405"), "sem amount não há tag 54");
  assert.equal(PDV.pixPayload({ key: "", name: "Loja" }), null);
  assert.equal(PDV.pixPayload({ key: "x@y.z", name: "" }), null);
  assert.equal(PDV.pixPayload({ key: "a".repeat(78), name: "Loja" }), null);
  // cidade vazia usa o padrão
  assert.ok(PDV.pixPayload({ key: "x@y.z", name: "Loja" }).includes("6006BRASIL"));
});

/* ---------- caixa ---------- */
const CASH_SALES = [
  { ts: "2026-07-04T10:00:00Z", total: 30, items: [], payment: { method: "dinheiro", received: 30, change: 0 } },
  { ts: "2026-07-04T11:00:00Z", total: 25, items: [], payment: { method: "pix", received: 25, change: 0 } },
  { ts: "2026-07-04T12:00:00Z", total: 10, items: [], payment: { method: "dinheiro", received: 20, change: 10 } },
  { ts: "2026-07-04T07:00:00Z", total: 99, items: [], payment: { method: "dinheiro", received: 99, change: 0 } } // antes da abertura
];

test("cashExpected: fundo + dinheiro do turno + reforços − sangrias", () => {
  const session = {
    openedAt: "2026-07-04T08:00:00Z", openingFloat: 50,
    movements: [{ type: "sangria", amount: 20 }, { type: "reforco", amount: 5 }]
  };
  // 50 + (30+10) + 5 − 20 = 75 — pix não entra na gaveta; venda das 07h é de antes
  assert.equal(PDV.cashExpected(session, CASH_SALES), 75);
  assert.equal(PDV.cashExpected(null, CASH_SALES), 0);
});

test("sessionSales respeita a janela de abertura/fechamento", () => {
  const open = { openedAt: "2026-07-04T08:00:00Z" };
  assert.equal(PDV.sessionSales(open, CASH_SALES).length, 3);
  const closed = { openedAt: "2026-07-04T08:00:00Z", closedAt: "2026-07-04T10:30:00Z" };
  assert.equal(PDV.sessionSales(closed, CASH_SALES).length, 1);
  assert.deepEqual(PDV.sessionSales(null, CASH_SALES), []);
});

/* ---------- relatórios ---------- */
test("salesSummary calcula total, itens e ticket médio", () => {
  const sum = PDV.salesSummary([
    { total: 10, items: [{ qty: 2 }] },
    { total: 20, items: [{ qty: 1 }, { qty: 3 }] }
  ]);
  assert.deepEqual(sum, { count: 2, total: 30, items: 6, avgTicket: 15 });
  assert.deepEqual(PDV.salesSummary([]), { count: 0, total: 0, items: 0, avgTicket: 0 });
  assert.deepEqual(PDV.salesSummary(null), { count: 0, total: 0, items: 0, avgTicket: 0 });
});

test("abcAnalysis classifica A/B/C por receita acumulada e calcula lucro", () => {
  const sales = [
    { items: [{ code: "1", name: "Campeão", price: 10, qty: 80 }] },   // 800
    { items: [{ code: "2", name: "Médio", price: 10, qty: 15 }] },     // 150
    { items: [{ code: "3", name: "Cauda", price: 10, qty: 5 }] }       // 50
  ];
  const rows = PDV.abcAnalysis(sales, { 1: 6 });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].code, "1");
  assert.equal(rows[0].cls, "A");
  assert.equal(rows[0].profit, 320);          // (10−6)×80
  assert.equal(rows[1].cls, "B");
  assert.equal(rows[1].profit, null);         // sem custo conhecido
  assert.equal(rows[2].cls, "C");
  // caso extremo: um único produto é sempre A
  const one = PDV.abcAnalysis([{ items: [{ code: "9", name: "Único", price: 5, qty: 1 }] }]);
  assert.equal(one[0].cls, "A");
  assert.deepEqual(PDV.abcAnalysis([]), []);
});

test("dailyAvgMap e daysOfStock estimam a reposição", () => {
  const now = "2026-07-04T12:00:00Z";
  const sales = [
    { ts: "2026-07-03T10:00:00Z", items: [{ code: "1", qty: 7 }] },
    { ts: "2026-07-01T10:00:00Z", items: [{ code: "1", qty: 7 }] },
    { ts: "2026-05-01T10:00:00Z", items: [{ code: "1", qty: 999 }] } // fora da janela de 14 dias
  ];
  const avg = PDV.dailyAvgMap(sales, 14, now);
  assert.equal(avg["1"], 1); // 14 unidades / 14 dias
  assert.equal(PDV.daysOfStock(5, avg["1"]), 5);
  assert.equal(PDV.daysOfStock(5, 0), Infinity);
  assert.equal(Object.keys(PDV.dailyAvgMap(null, 14, now)).length, 0);
});

/* ---------- indicadores gerenciais ---------- */
test("salesByOperator ranqueia vendedores por faturamento", () => {
  const sales = [
    { operator: "Ana", total: 100, items: [{ qty: 2 }] },
    { operator: "Ana", total: 50, items: [{ qty: 1 }] },
    { operator: "Bia", total: 30, items: [{ qty: 3 }] }
  ];
  const rows = PDV.salesByOperator(sales);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].operator, "Ana");
  assert.equal(rows[0].revenue, 150);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].items, 3);
  assert.equal(rows[1].operator, "Bia");
  assert.deepEqual(PDV.salesByOperator([]), []);
});

test("salesByHour e salesByWeekday agrupam por horário e dia local", () => {
  const d1 = new Date(2026, 6, 6, 9, 0, 0);  // segunda-feira, 09h
  const d2 = new Date(2026, 6, 6, 9, 30, 0); // segunda-feira, 09h
  const d3 = new Date(2026, 6, 7, 18, 0, 0); // terça-feira, 18h
  const sales = [
    { ts: d1.toISOString(), total: 10 },
    { ts: d2.toISOString(), total: 20 },
    { ts: d3.toISOString(), total: 5 }
  ];
  const hours = PDV.salesByHour(sales);
  assert.equal(hours.length, 24);
  assert.equal(hours[9].count, 2);
  assert.equal(hours[9].revenue, 30);
  assert.equal(hours[18].count, 1);

  const weekdays = PDV.salesByWeekday(sales);
  assert.equal(weekdays.length, 7);
  assert.equal(weekdays[d1.getDay()].count, 2);
  assert.equal(weekdays[d1.getDay()].revenue, 30);
  assert.equal(weekdays[d3.getDay()].count, 1);
  assert.deepEqual(PDV.salesByHour(null).reduce((a, b) => a + b.count, 0), 0);
});

test("paymentBreakdown soma faturamento por forma de pagamento", () => {
  const sales = [
    { total: 10, payment: { method: "dinheiro" } },
    { total: 20, payment: { method: "pix" } },
    { total: 30, payment: { method: "dinheiro" } },
    { total: 5, payment: null }
  ];
  const rows = PDV.paymentBreakdown(sales);
  assert.equal(rows[0].method, "dinheiro");
  assert.equal(rows[0].revenue, 40);
  assert.equal(rows[0].count, 2);
  assert.ok(rows.some(r => r.method === "—" && r.revenue === 5));
});

test("dailyRevenueSeries preenche todos os dias da janela, mesmo sem vendas", () => {
  const now = "2026-07-04T12:00:00Z";
  const sales = [
    { ts: "2026-07-04T10:00:00Z", total: 15 },
    { ts: "2026-07-02T10:00:00Z", total: 5 }
  ];
  const series = PDV.dailyRevenueSeries(sales, 3, now);
  assert.equal(series.length, 3);
  assert.equal(series[2].revenue, 15); // hoje
  assert.equal(series[0].revenue, 5);  // 2 dias atrás
  assert.equal(series[1].revenue, 0);  // ontem, sem vendas
});

test("basketPairs identifica produtos comprados juntos", () => {
  const sales = [
    { items: [{ code: "1", name: "Pão" }, { code: "2", name: "Manteiga" }] },
    { items: [{ code: "1", name: "Pão" }, { code: "2", name: "Manteiga" }] },
    { items: [{ code: "1", name: "Pão" }, { code: "3", name: "Café" }] },
    { items: [{ code: "9", name: "Sozinho" }] }
  ];
  const pairs = PDV.basketPairs(sales);
  assert.equal(pairs[0].a, "1"); assert.equal(pairs[0].b, "2"); assert.equal(pairs[0].count, 2);
  assert.equal(pairs.find(p => p.b === "3").count, 1);
  assert.equal(PDV.basketPairs(sales, 1).length, 1);
  assert.deepEqual(PDV.basketPairs([]), []);
});
