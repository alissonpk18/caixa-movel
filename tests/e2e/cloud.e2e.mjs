/* E2E do modo nuvem (SaaS) — roda SEM Supabase real, com o fake
   compartilhado (fake-supabase.mjs). Valida o desenho atual: não existe
   nenhuma tela de "conectar à nuvem" — o aparelho usa só o login de
   sempre (usuário/senha); se o usuário não existe localmente, o app
   pergunta à nuvem (RPC login_operator) e se vincula automaticamente
   à empresa correta. */
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { wireFakeCloud, seedFakeStore, peekFakeDb } from "./fake-supabase.mjs";

const BASE = (process.env.PDV_URL || "http://localhost:8899") + "/pdv-mobile.html";
const passHash = (pw) => createHash("sha256").update("pdv#v1:"+pw).digest("hex");
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
};

const STORE_ID = "store-mercadinho";
const USERS = [
  { username:"donagerente", name:"Dona Maria", role:"gerente", canAddStock:true, passHash: passHash("segredo123") },
  { username:"caixa2",      name:"Caixa 2",     role:"operador", canAddStock:false, passHash: passHash("789456") }
];
const PRODUCTS = [{ code:"7891000100103", name:"Leite Integral 1L", price:5.49, cost:null, qty:40, exp:null }];

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

/* ---- 0. sem configuração: modo local intocado, lib da nuvem nem carrega ---- */
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdnCalls = [];
  page.on("request", r => { if (r.url().includes("supabase")) cdnCalls.push(r.url()); });
  await page.goto(BASE);
  await page.waitForTimeout(600);
  check("sem config: login local funciona", await page.isVisible("#loginUser"));
  check("sem config: lib da nuvem não é baixada", cdnCalls.length === 0, cdnCalls.join(","));
  check("sem config: não existe elemento de nuvem na tela", (await page.locator("#cloudBox").count()) === 0);
  await ctx.close();
}

/* ---- "aparelho A": entra direto com usuário/senha de uma empresa que
   ele nunca viu — precisa rotear e vincular sozinho, sem nenhuma tela extra ---- */
seedFakeStore({ storeId: STORE_ID, name: "Mercadinho da Dona", users: USERS, products: PRODUCTS });

const ctxA = await browser.newContext();
await wireFakeCloud(ctxA);
const pageA = await ctxA.newPage();
const errorsA = [];
pageA.on("pageerror", e => errorsA.push("pageerror: " + e.message));

await pageA.goto(BASE);
check("tela de login é só a de sempre (sem card de nuvem)", (await pageA.locator("#cloudBox").count()) === 0);

await pageA.fill("#loginUser", "donagerente");
await pageA.fill("#loginPass", "segredo123");
await pageA.click("#loginBtn");
await pageA.waitForSelector("#gerente.is-active", { timeout: 8000 });
check("login direto roteia para a empresa certa (sem tela extra)", true);

await pageA.waitForFunction(() => DB.products.some(p => p.code === "7891000100103"), null, { timeout: 8000 });
check("estoque da empresa foi baixado após o roteamento", await pageA.evaluate(() =>
  (DB.products.find(p => p.code === "7891000100103") || {}).qty === 40));

check("aparelho A ficou vinculado à empresa (device_links)", peekFakeDb().device_links.length === 1);

/* venda no aparelho A sobe para a nuvem */
await pageA.evaluate(() => {
  state.cart.push({ code: "7891000100103", name: "Leite Integral 1L", price: 5.49, qty: 3 });
  finalizeSale({ method: "dinheiro", received: 20, change: 20 - 16.47 });
});
const t0 = Date.now();
while (Date.now() - t0 < 8000 && peekFakeDb().sales.length < 1) await new Promise(r=>setTimeout(r,50));
check("venda do aparelho A sincronizada", peekFakeDb().sales.length === 1);

/* ---- "aparelho B": nunca viu essa empresa, mesmas credenciais ---- */
const ctxB = await browser.newContext();
await wireFakeCloud(ctxB);
const pageB = await ctxB.newPage();
const errorsB = [];
pageB.on("pageerror", e => errorsB.push("pageerror: " + e.message));

await pageB.goto(BASE);
await pageB.fill("#loginUser", "caixa2");
await pageB.fill("#loginPass", "789456");
await pageB.click("#loginBtn");
await pageB.waitForSelector("#operador.is-active", { timeout: 8000 });
check("aparelho B (novo) também roteia com as mesmas credenciais da empresa", true);
await pageB.waitForFunction(() => DB.sales.length === 1, null, { timeout: 8000 });
check("aparelho B vê a venda feita no aparelho A", true);
check("permissão do usuário veio certa (caixa sem +Estoque)", !(await pageB.isVisible("#restockBtn")));

/* ---- credencial errada: sem crash, sem vínculo indevido ---- */
await pageB.click("#logoutOp");
await pageB.fill("#loginUser", "donagerente");
await pageB.fill("#loginPass", "senhaerrada");
await pageB.click("#loginBtn");
await pageB.waitForFunction(() => document.getElementById("loginErr").textContent.length > 0, null, { timeout: 5000 });
check("senha errada não loga em lugar nenhum", (await pageB.textContent("#loginErr")).includes("incorretos"));

check("sem erros de JS (aparelho A)", errorsA.length === 0, errorsA.join(" | "));
check("sem erros de JS (aparelho B)", errorsB.length === 0, errorsB.join(" | "));

await ctxA.close();
await ctxB.close();
await browser.close();
if (failures) { console.error(`\n${failures} FALHA(S) NO MODO NUVEM`); process.exit(1); }
console.log("\nTODOS OS TESTES DO MODO NUVEM PASSARAM");
