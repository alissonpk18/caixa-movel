/* E2E do console do administrador (admin.html) — sem Supabase real:
   usa o fake compartilhado (fake-supabase.mjs), que simula o RLS
   incluindo a tabela admins. Valida: bloqueio de conta comum; listagem
   das empresas; gestão de gerentes/caixas; e a "ligação correta" —
   o acesso criado pelo admin funciona no PDV da loja. */
import { chromium } from "playwright";
import { wireFakeCloud } from "./fake-supabase.mjs";

const ROOT = process.env.PDV_URL || "http://localhost:8899";
const PDV = ROOT + "/pdv-mobile.html";
const ADMIN = ROOT + "/admin.html";
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
};

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext();
await wireFakeCloud(ctx);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message));

/* ---- 1. prepara uma empresa: dona cria a loja pelo PDV ---- */
await page.goto(PDV);
await page.waitForSelector("#cloudBox", { state: "visible", timeout: 5000 });
await page.fill("#cloudEmail", "dona@mercadinho.com");
await page.fill("#cloudPass", "segredo123");
await page.click("#cloudSignupBtn");
await page.waitForSelector("#cloudStatus", { state: "visible", timeout: 5000 });
await page.waitForFunction(() => {
  const d = JSON.parse(localStorage.getItem("fake:db") || "{}");
  return (d.kv || []).some(r => r.key === "users");
}, null, { timeout: 8000 });
check("empresa criada pelo PDV", true);

/* promove a conta do admin (equivale ao insert em public.admins do schema) */
await page.evaluate(() => {
  const d = JSON.parse(localStorage.getItem("fake:db"));
  d.admins = [{ user_id: "u-admin@plataforma.com" }];
  localStorage.setItem("fake:db", JSON.stringify(d));
});

/* ---- 2. conta comum não entra no console ---- */
await page.goto(ADMIN);
await page.waitForSelector("#admLogin", { state: "visible", timeout: 5000 });
await page.fill("#admEmail", "dona@mercadinho.com");
await page.fill("#admPass", "segredo123");
await page.click("#admLoginBtn");
await page.waitForFunction(() => document.getElementById("admErr").textContent.length > 0, null, { timeout: 5000 });
check("conta comum é recusada no console", (await page.textContent("#admErr")).includes("não é administradora"));

/* ---- 3. admin entra e vê as empresas ---- */
await page.fill("#admEmail", "admin@plataforma.com");
await page.fill("#admPass", "chavemestra");
await page.click("#admLoginBtn");
await page.waitForSelector("#admStores", { state: "visible", timeout: 5000 });
const listTxt = await page.textContent("#storeList");
check("admin vê a empresa e a conta dona", listTxt.includes("Minha loja") && listTxt.includes("dona@mercadinho.com"));

/* ---- 4. abre a empresa e gerencia os acessos ---- */
await page.click("#storeList .store");
await page.waitForSelector("#admStore", { state: "visible", timeout: 5000 });
check("acessos da empresa aparecem (gerente e caixa)", (await page.textContent("#userList")).includes("@gerente"));

// adiciona uma nova caixa
await page.fill("#nu_user", "maria");
await page.fill("#nu_name", "Maria Souza");
await page.selectOption("#nu_role", "operador");
await page.fill("#nu_pass", "789456");
await page.click("#nu_addBtn");
await page.waitForFunction(() => document.getElementById("uMsg").textContent.includes("maria"), null, { timeout: 5000 });
const kvUsers = await page.evaluate(() => {
  const d = JSON.parse(localStorage.getItem("fake:db"));
  return d.kv.find(r => r.key === "users").value;
});
const maria = kvUsers.find(u => u.username === "maria");
check("caixa adicionada à empresa na nuvem", kvUsers.length === 3 && !!maria);
check("senha guardada como hash (não em texto)", !!maria.passHash && !maria.password);

// libera a permissão de reposição de estoque
await page.click('#userList button[data-a="perm"][data-i="2"]');
await page.waitForFunction(() => {
  const d = JSON.parse(localStorage.getItem("fake:db"));
  const u = d.kv.find(r => r.key === "users").value.find(x => x.username === "maria");
  return u && u.canAddStock === true;
}, null, { timeout: 5000 });
check("permissão de reposição liberada pelo admin", true);

// renomeia a empresa
await page.fill("#stName", "Mercadinho da Dona");
await page.click("#stSaveBtn");
await page.waitForFunction(() => {
  const d = JSON.parse(localStorage.getItem("fake:db"));
  return d.stores[0].name === "Mercadinho da Dona";
}, null, { timeout: 5000 });
check("empresa renomeada sem perder a dona", await page.evaluate(() => {
  const d = JSON.parse(localStorage.getItem("fake:db"));
  return d.stores[0].owner === "u-dona@mercadinho.com";
}));

/* ---- 5. a "ligação" funciona: maria entra no PDV da loja ---- */
await page.evaluate(() => {
  // devolve a sessão de nuvem da loja (o admin usou a dele no console)
  localStorage.setItem("fake:session", JSON.stringify({ user: { id: "u-dona@mercadinho.com", email: "dona@mercadinho.com" } }));
});
await page.goto(PDV);
await page.waitForFunction(() => typeof DB !== "undefined" && DB.users.length === 3, null, { timeout: 8000 });
await page.fill("#loginUser", "maria");
await page.fill("#loginPass", "789456");
await page.click("#loginBtn");
await page.waitForSelector("#operador.is-active", { timeout: 5000 });
check("acesso criado pelo admin loga no PDV da loja", true);
check("permissão dada pelo admin vale no PDV (+Estoque)", await page.isVisible("#restockBtn"));

check("sem erros de JS nas páginas", errors.length === 0, errors.join(" | "));

await ctx.close();
await browser.close();
if (failures) { console.error(`\n${failures} FALHA(S) NO CONSOLE ADMIN`); process.exit(1); }
console.log("\nTODOS OS TESTES DO CONSOLE ADMIN PASSARAM");
