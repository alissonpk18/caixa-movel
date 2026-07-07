/* E2E do modo nuvem (SaaS) — roda SEM Supabase real:
   - intercepta js/config.js para devolver uma configuração preenchida;
   - intercepta a lib da nuvem e serve um Supabase falso em memória,
     persistido em localStorage (sobrevive a reload = simula a mesma
     loja aberta em "outro aparelho").
   Valida: modo local intocado sem config; signup; seed da loja vazia;
   push de venda; pull completo num "segundo aparelho". */
import { chromium } from "playwright";
import { wireFakeCloud } from "./fake-supabase.mjs";

const BASE = (process.env.PDV_URL || "http://localhost:8899") + "/pdv-mobile.html";
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
};

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

/* ---- 0. sem configuração: modo local intocado, lib da nuvem nem carrega ---- */
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdnCalls = [];
  page.on("request", r => { if (r.url().includes("supabase")) cdnCalls.push(r.url()); });
  await page.goto(BASE);
  await page.waitForTimeout(600);
  check("sem config: caixa de nuvem continua oculta", await page.isHidden("#cloudBox"));
  check("sem config: lib da nuvem não é baixada", cdnCalls.length === 0, cdnCalls.join(","));
  check("sem config: login local funciona", await page.isVisible("#loginUser"));
  await ctx.close();
}

/* ---- contexto com nuvem "ligada" (config + lib falsas) ---- */
const ctx = await browser.newContext();
await wireFakeCloud(ctx);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message));

/* ---- 1. caixa de nuvem aparece; signup conecta a loja ---- */
await page.goto(BASE);
await page.waitForSelector("#cloudBox", { state: "visible", timeout: 5000 });
check("com config: caixa de nuvem aparece no login", true);
await page.fill("#cloudEmail", "dona@mercadinho.com");
await page.fill("#cloudPass", "segredo123");
await page.click("#cloudSignupBtn");
await page.waitForSelector("#cloudStatus", { state: "visible", timeout: 5000 });
check("signup conecta e mostra a loja", (await page.textContent("#cloudWho")).includes("dona@mercadinho.com"));

/* ---- 2. nuvem estava vazia: o estoque local (seed) subiu ---- */
await page.waitForTimeout(500);
const fake1 = await page.evaluate(() => JSON.parse(localStorage.getItem("fake:db")));
check("loja criada na nuvem", fake1.stores.length === 1 && fake1.stores[0].owner === "u-dona@mercadinho.com");
check("estoque local subiu para a nuvem", fake1.products.length >= 8, "products=" + fake1.products.length);
check("usuários/config subiram (kv)", fake1.kv.some(r => r.key === "users") && fake1.kv.some(r => r.key === "settings"));

/* ---- 3. uma venda é empurrada para a nuvem (debounce ~1,5s) ---- */
await page.evaluate(() => {
  state.user = DB.users.find(u => u.role === "operador") || DB.users[0];
  state.cart.push({ code: "7891000100103", name: "Leite Integral 1L", price: 5.49, qty: 2 });
  finalizeSale({ method: "dinheiro", received: 20, change: 20 - 10.98 });
});
await page.waitForFunction(() => {
  const d = JSON.parse(localStorage.getItem("fake:db") || "{}");
  return (d.sales || []).length === 1;
}, null, { timeout: 8000 });
const fake2 = await page.evaluate(() => JSON.parse(localStorage.getItem("fake:db")));
check("venda sincronizada para a nuvem", fake2.sales.length === 1 && Number(fake2.sales[0].total) === 10.98);
check("estoque atualizado na nuvem (40−2=38)", Number((fake2.products.find(p => p.code === "7891000100103") || {}).qty) === 38);

/* ---- 4. "segundo aparelho": storage do app limpo, sessão da nuvem mantida ---- */
await page.evaluate(() => {
  Object.keys(localStorage).filter(k => k.startsWith("pdv:")).forEach(k => localStorage.removeItem(k));
});
await page.reload();
await page.waitForSelector("#cloudStatus", { state: "visible", timeout: 8000 });
await page.waitForFunction(() => DB.sales.length === 1, null, { timeout: 8000 });
const dev2 = await page.evaluate(() => ({
  sales: DB.sales.length,
  leite: (DB.products.find(p => p.code === "7891000100103") || {}).qty,
  users: DB.users.length
}));
check("2º aparelho puxa as vendas da nuvem", dev2.sales === 1);
check("2º aparelho puxa o estoque atualizado", dev2.leite === 38, "qty=" + dev2.leite);
check("2º aparelho puxa os usuários da loja", dev2.users >= 2, "users=" + dev2.users);

/* ---- 5. desconectar volta ao modo local ---- */
await page.click("#cloudLogoutBtn");
await page.waitForSelector("#cloudForm", { state: "visible", timeout: 5000 });
check("desconectar mostra o formulário de novo", true);

check("sem erros de JS na página", errors.length === 0, errors.join(" | "));

await ctx.close();
await browser.close();
if (failures) { console.error(`\n${failures} FALHA(S) NO MODO NUVEM`); process.exit(1); }
console.log("\nTODOS OS TESTES DO MODO NUVEM PASSARAM");
