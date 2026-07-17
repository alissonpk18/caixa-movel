/* E2E do modo nuvem (SaaS) — roda SEM Supabase real, com o fake
   compartilhado (fake-supabase.mjs). Valida o desenho atual: não existe
   nenhuma tela de "conectar à nuvem" — o aparelho usa só o login de
   sempre (usuário/senha); se o usuário não existe localmente, o app
   pergunta à nuvem (RPC login_operator) e se vincula automaticamente
   à empresa correta. Valida também: A-02 — vendas concorrentes do
   mesmo produto em aparelhos diferentes não perdem baixa de estoque
   (RPC apply_sale, atômica); e A-06 — dois aparelhos mexendo no mesmo
   caixa aberto ao mesmo tempo não perdem movimento (eventos append-only). */
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

/* ---- 0. sem configuração: modo local intocado, lib da nuvem nem carrega.
   Simula js/config.js vazio (independente do que estiver de fato commitado
   em produção) para testar o modo local isoladamente. ---- */
{
  const ctx = await browser.newContext();
  await ctx.route("**/js/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: '"use strict"; const CLOUD_CONFIG = { url: "", anonKey: "" };'
  }));
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

/* ---- achado A-02 do relatório de arquitetura: duas vendas do MESMO
   produto em aparelhos diferentes, SEM sincronizar entre uma e outra —
   cada aparelho decide a partir do próprio estoque local desatualizado.
   Com "última escrita vence" uma das baixas sumiria; com apply_sale
   (delta atômico no banco) as duas se aplicam, não importa a ordem. ---- */
const qtyBeforeRace = peekFakeDb().products.find(p => p.code === "7891000100103").qty;
check("estoque antes da corrida é o esperado (40−3=37)", qtyBeforeRace === 37, "qty=" + qtyBeforeRace);

await pageA.evaluate(() => {
  state.cart.push({ code: "7891000100103", name: "Leite Integral 1L", price: 5.49, qty: 2 });
  finalizeSale({ method: "dinheiro", received: 20, change: 0 });
});
await pageB.evaluate(() => {
  state.cart.push({ code: "7891000100103", name: "Leite Integral 1L", price: 5.49, qty: 5 });
  finalizeSale({ method: "dinheiro", received: 50, change: 0 });
});
const t1 = Date.now();
while (Date.now() - t1 < 8000 && peekFakeDb().sales.length < 3) await new Promise(r => setTimeout(r, 50));
check("as duas vendas concorrentes chegaram na nuvem", peekFakeDb().sales.length === 3);
const qtyAfterRace = peekFakeDb().products.find(p => p.code === "7891000100103").qty;
check("nenhuma baixa de estoque se perde na corrida (37−2−5=30)", qtyAfterRace === 30, "qty=" + qtyAfterRace);

/* ---- achado A-06 do relatório de arquitetura: dois aparelhos mexendo
   no MESMO caixa aberto, sem sincronizar entre uma ação e outra — antes
   o caixa inteiro era um documento só ("última escrita vence") e um
   aparelho apagava o movimento do outro; agora cada ação é um evento
   próprio (append-only, como as vendas). ---- */
await pageB.evaluate(() => { document.getElementById("cash_float").value = "100"; openCash(); });
await pageB.evaluate(() => cloudSync());
await pageA.evaluate(() => cloudSync());
check("aparelho A recebe a abertura de caixa feita pelo aparelho B", await pageA.evaluate(() => !!(DB.cash.open && DB.cash.open.openingFloat === 100)));

// sem sincronizar entre uma ação e outra: cada aparelho só enxerga o
// próprio movimento até este ponto
await pageA.evaluate(() => { document.getElementById("cash_mov").value = "30"; cashMovement("reforco"); });
await pageB.evaluate(() => { document.getElementById("cash_mov").value = "10"; cashMovement("sangria"); });
await pageA.evaluate(() => cloudSync());
await pageB.evaluate(() => cloudSync());
await pageA.evaluate(() => cloudSync()); // 2ª volta: pega o que o B acabou de mandar

const cashEventsCount = peekFakeDb().cash_events.length;
check("os 3 eventos de caixa chegaram na nuvem (abertura + 2 movimentos)", cashEventsCount === 3, "eventos=" + cashEventsCount);
const movementsOnA = await pageA.evaluate(() => DB.cash.open.movements.length);
check("nenhum movimento de caixa se perde na corrida (reforço do A + sangria do B)", movementsOnA === 2, "movimentos=" + movementsOnA);

/* ---- no modo nuvem, editar/remover acesso continua exclusivo do
   console do admin — uma edição local nunca subiria (o RLS bloqueia) e
   seria desfeita em silêncio pelo pull seguinte; mas a GERÊNCIA pode
   cadastrar novos caixas direto do aparelho via RPC create_operator ---- */
await pageA.evaluate(() => switchTab("usuarios"));
check("modo nuvem: gerência ainda vê o cadastro de usuário (só caixa)", await pageA.isVisible("#userAddBox"));
check("modo nuvem: aviso do que fica com o console aparece", await pageA.isVisible("#usersCloudNote"));
check("modo nuvem: seletor de perfil trava em Caixa (sem opção Gerência)",
  await pageA.evaluate(() => document.getElementById("nu_role").disabled &&
    getComputedStyle(document.querySelector('#nu_role option[value="gerente"]')).display === "none"));
check("modo nuvem: lista de usuários sem botões de excluir/permissão",
  (await pageA.locator("#userList [data-act]").count()) === 0);

await pageA.fill("#nu_name", "Caixa Novo");
await pageA.fill("#nu_user", "caixanovo");
await pageA.fill("#nu_pass", "outrasenha1");
await pageA.click("#addUserBtn");
await pageA.waitForFunction(() => DB.users.some(u => u.username === "caixanovo"), null, { timeout: 8000 });
check("gerência cadastrou um novo caixa pela RPC create_operator", true);
check("o novo caixa foi criado com papel operador (nunca gerente)",
  peekFakeDb().operators.find(o => o.username === "caixanovo").role === "operador");

/* tentar cadastrar de novo com o mesmo login dá erro de duplicidade,
   sem travar o formulário nem duplicar a linha em operators */
await pageA.fill("#nu_name", "Caixa Duplicado");
await pageA.fill("#nu_user", "caixanovo");
await pageA.fill("#nu_pass", "outrasenha1");
await pageA.click("#addUserBtn");
await pageA.waitForFunction(() => document.getElementById("nu_err").textContent.length > 0, null, { timeout: 8000 });
check("login duplicado no cadastro pela gerência dá erro (sem duplicar)",
  peekFakeDb().operators.filter(o => o.username === "caixanovo").length === 1);

/* ---- acesso removido pelo console some do aparelho no próximo sync,
   deslogando a sessão em vez de deixá-la seguir operando órfã ---- */
peekFakeDb().operators.splice(peekFakeDb().operators.findIndex(o => o.username === "caixa2"), 1);
await pageB.evaluate(() => cloudSync());
await pageB.waitForSelector("#login.is-active", { timeout: 8000 });
check("acesso removido pelo console desloga o aparelho no sync seguinte", true);

/* ---- credencial errada: sem crash, sem vínculo indevido ---- */
await pageB.fill("#loginUser", "donagerente");
await pageB.fill("#loginPass", "senhaerrada");
await pageB.click("#loginBtn");
await pageB.waitForFunction(() => document.getElementById("loginErr").textContent.length > 0, null, { timeout: 5000 });
check("senha errada não loga em lugar nenhum", (await pageB.textContent("#loginErr")).includes("incorretos"));

check("sem erros de JS (aparelho A)", errorsA.length === 0, errorsA.join(" | "));
check("sem erros de JS (aparelho B)", errorsB.length === 0, errorsB.join(" | "));

// força um ciclo de sync completo (push+pull) para checar a marca —
// o debounce normal só agenda o push; o pull roda no laço periódico/
// eventos de visibilidade, que este teste não espera acontecer sozinho
await pageA.evaluate(() => cloudSync());
const salesMark = await pageA.evaluate(store => sget("pdv:cloudSalesPullMark:" + store), STORE_ID);
check("marca do pull incremental de vendas foi gravada (A-05)", typeof salesMark === "string" && salesMark.length > 0, "mark=" + salesMark);

/* ---- mesmo aparelho reaproveitado por OUTRA empresa: o sync
   incremental de vendas (A-05) mescla em vez de substituir, então sem
   essa guarda um aparelho trocado de empresa ficaria com vendas de
   duas empresas misturadas. ---- */
const STORE2_ID = "store-outra-empresa";
const USERS2 = [{ username:"gerente2", name:"Outro Gerente", role:"gerente", canAddStock:true, passHash: passHash("outrasenha") }];
const PRODUCTS2 = [{ code:"9999999999999", name:"Produto da Outra Empresa", price:1, cost:null, qty:10, exp:null }];
seedFakeStore({ storeId: STORE2_ID, name: "Outra Empresa", users: USERS2, products: PRODUCTS2 });

const ctxC = await browser.newContext();
await wireFakeCloud(ctxC);
const pageC = await ctxC.newPage();
const errorsC = [];
pageC.on("pageerror", e => errorsC.push("pageerror: " + e.message));

await pageC.goto(BASE);
await pageC.fill("#loginUser", "donagerente");
await pageC.fill("#loginPass", "segredo123");
await pageC.click("#loginBtn");
await pageC.waitForSelector("#gerente.is-active", { timeout: 8000 });
await pageC.waitForFunction(() => DB.sales.length === 3, null, { timeout: 8000 });
check("aparelho C (novo) baixa o histórico da 1ª empresa normalmente", true);

await pageC.click("#logoutGer");
await pageC.fill("#loginUser", "gerente2");
await pageC.fill("#loginPass", "outrasenha");
await pageC.click("#loginBtn");
await pageC.waitForSelector("#gerente.is-active", { timeout: 8000 });
await pageC.waitForFunction(() => DB.products.some(p => p.code === "9999999999999"), null, { timeout: 8000 });
const salesAfterSwitch = await pageC.evaluate(() => DB.sales.length);
check("trocar de empresa no mesmo aparelho não mistura vendas da empresa anterior", salesAfterSwitch === 0, "sales=" + salesAfterSwitch);
check("sem erros de JS (aparelho C)", errorsC.length === 0, errorsC.join(" | "));

await ctxA.close();
await ctxB.close();
await ctxC.close();
await browser.close();
if (failures) { console.error(`\n${failures} FALHA(S) NO MODO NUVEM`); process.exit(1); }
console.log("\nTODOS OS TESTES DO MODO NUVEM PASSARAM");
