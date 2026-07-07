/* E2E do console do administrador (admin.html) — sem Supabase real:
   usa o fake compartilhado (fake-supabase.mjs), que simula o RLS
   incluindo a tabela admins. Valida o fluxo completo: bloqueio de conta
   comum; admin cria a empresa pelo próprio console (não existe mais
   cadastro pelo lojista); admin cadastra gerente/caixa; a "ligação
   correta" pedida — quando essa pessoa loga no PDV com usuário/senha,
   o aparelho é direcionado sozinho para a empresa certa, sem nenhuma
   tela de "conectar à nuvem"; e a revogação de aparelho (achado A-01 do
   relatório de arquitetura): o admin corta o vínculo pelo console e o
   aparelho é desconectado no sync seguinte, sem perder os dados locais. */
import { chromium } from "playwright";
import { wireFakeCloud, seedAdmin, peekFakeDb } from "./fake-supabase.mjs";

const ROOT = process.env.PDV_URL || "http://localhost:8899";
const PDV = ROOT + "/pdv-mobile.html";
const ADMIN = ROOT + "/admin.html";
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
};
/* o banco falso agora é compartilhado no processo Node; espera uma
   condição nele em vez de reler localStorage de dentro da página */
async function waitDb(pred, timeout = 5000){
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (pred(peekFakeDb())) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("waitDb: timeout");
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext();
await wireFakeCloud(ctx);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message));

/* ---- 1. promove a conta do admin (equivale ao insert em public.admins do schema) ---- */
seedAdmin("admin@plataforma.com");
await page.goto(ADMIN);

/* ---- 2. conta comum não entra no console ---- */
await page.waitForSelector("#admLogin", { state: "visible", timeout: 5000 });
await page.fill("#admEmail", "vendedor@qualquer.com");
await page.fill("#admPass", "123456");
await page.click("#admLoginBtn");
await page.waitForFunction(() => document.getElementById("admErr").textContent.length > 0, null, { timeout: 5000 });
check("conta comum é recusada no console", (await page.textContent("#admErr")).includes("não é administradora"));

/* ---- 3. admin entra ---- */
await page.fill("#admEmail", "admin@plataforma.com");
await page.fill("#admPass", "chavemestra");
await page.click("#admLoginBtn");
await page.waitForSelector("#admStores", { state: "visible", timeout: 5000 });

/* ---- 4. admin cria a empresa direto pelo console (não existe mais
   cadastro pelo lojista — quem cria é sempre o admin) ---- */
await page.fill("#ns_name", "Mercadinho da Dona");
await page.fill("#ns_email", "dona@mercadinho.com");
await page.click("#ns_addBtn");
await page.waitForFunction(() => document.getElementById("storeList").textContent.includes("Mercadinho da Dona"), null, { timeout: 5000 });
check("admin cria a empresa pelo próprio console", true);

/* ---- 5. abre a empresa e cadastra gerente + caixa ---- */
await page.click("#storeList .store");
await page.waitForSelector("#admStore", { state: "visible", timeout: 5000 });
check("empresa recém-criada começa sem acessos", (await page.textContent("#userList")).includes("Nenhum acesso"));

await page.fill("#nu_user", "donagerente");
await page.fill("#nu_name", "Dona Maria");
await page.selectOption("#nu_role", "gerente");
await page.fill("#nu_pass", "segredo123");
await page.click("#nu_addBtn");
await page.waitForFunction(() => document.getElementById("uMsg").textContent.includes("donagerente"), null, { timeout: 5000 });

await page.fill("#nu_user", "maria");
await page.fill("#nu_name", "Maria Souza");
await page.selectOption("#nu_role", "operador");
await page.fill("#nu_pass", "789456");
await page.click("#nu_addBtn");
await page.waitForFunction(() => document.getElementById("uMsg").textContent.includes("maria"), null, { timeout: 5000 });
const kvUsers = peekFakeDb().kv.find(r => r.key === "users").value;
check("gerente e caixa cadastrados pelo admin", kvUsers.length === 2);
check("senha guardada como hash (não em texto)", kvUsers.every(u => u.passHash && !u.password));

// libera a permissão de reposição de estoque da caixa
await page.click('#userList button[data-a="perm"][data-i="1"]');
await waitDb(d => {
  const u = d.kv.find(r => r.key === "users").value.find(x => x.username === "maria");
  return u && u.canAddStock === true;
});
check("permissão de reposição liberada pelo admin", true);

check("sem erros de JS no admin.html", errors.length === 0, errors.join(" | "));

/* ---- 6. a "ligação correta": um APARELHO NOVO (nunca viu essa nuvem)
   loga direto com usuário/senha — sem NENHUMA tela de conectar — e o
   app descobre sozinho que essa conta é da empresa que o admin criou ---- */
const ctx2 = await browser.newContext();          // aparelho novo de verdade
await wireFakeCloud(ctx2);
const page2 = await ctx2.newPage();
const errors2 = [];
page2.on("pageerror", e => errors2.push("pageerror: " + e.message));

await page2.goto(PDV);
check("PDV não tem nenhum elemento de nuvem na tela", (await page2.locator("#cloudBox").count()) === 0);
await page2.fill("#loginUser", "maria");
await page2.fill("#loginPass", "789456");
await page2.click("#loginBtn");
await page2.waitForSelector("#operador.is-active", { timeout: 8000 });
check("acesso criado pelo admin loga direto no aparelho novo", true);
check("permissão dada pelo admin vale no PDV (+Estoque)", await page2.isVisible("#restockBtn"));

check("sem erros de JS no PDV", errors2.length === 0, errors2.join(" | "));

/* ---- 7. achado A-01 do relatório de arquitetura: revogar o aparelho da
   maria pelo console — ela para de sincronizar, mas os dados que já
   tinha localmente (baixados antes da revogação) NÃO são apagados ---- */
await page.click("#backBtn");
await page.waitForSelector("#admStores", { state: "visible", timeout: 5000 });
await page.click("#storeList .store");
await page.waitForSelector("#admStore", { state: "visible", timeout: 5000 });
await page.waitForFunction(() => document.getElementById("deviceList").textContent.includes("@maria"), null, { timeout: 5000 });
check("aparelho da maria aparece na lista após o login dela", true);

page.once("dialog", d => d.accept()); // confirm() nativo de "revogar"
await page.click('#deviceList button[data-uid]');
await page.waitForFunction(() => document.getElementById("uMsg").textContent.includes("revogado"), null, { timeout: 5000 });
check("admin revoga o aparelho pelo console", true);

const localUsersBefore = await page2.evaluate(() => DB.users.length);
check("aparelho revogado ainda tem os dados locais intactos até o próximo sync", localUsersBefore === 2);

await page2.evaluate(() => cloudSync());
await page2.waitForSelector("#login.is-active", { timeout: 8000 });
check("aparelho revogado é desconectado (deslogado) no sync seguinte", true);
const localUsersAfter = await page2.evaluate(() => DB.users.length);
check("dados locais NÃO são apagados pela revogação", localUsersAfter === localUsersBefore, `antes=${localUsersBefore} depois=${localUsersAfter}`);

await ctx.close();
await ctx2.close();
await browser.close();
if (failures) { console.error(`\n${failures} FALHA(S) NO CONSOLE ADMIN`); process.exit(1); }
console.log("\nTODOS OS TESTES DO CONSOLE ADMIN PASSARAM");
