/* E2E: gerente cadastra/gerencia os CAIXAS da própria empresa direto
   pela tela de gerência (js/users.js), sem depender do console
   admin.html — e o novo caixa herda automaticamente a empresa (store_id)
   do gerente logado, nunca escolhida no cliente. Roda com o fake
   compartilhado (fake-supabase.mjs), sem Supabase real.

   Regras de negócio validadas:
   - só o admin da plataforma cria/edita conta de GERENTE (a tela de
     gerência nem oferece mais essa opção — #nu_role foi removido);
   - o gerente só enxerga/mexe nos caixas da PRÓPRIA empresa: a RPC
     resolve store_id no banco a partir de quem está logado, e recusa
     tocar numa empresa diferente mesmo que alguém chame a RPC direto,
     sem passar pela UI (bypass do cliente). */
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

const STORE_A = "store-mercadinho-a";
const STORE_B = "store-mercadinho-b";
seedFakeStore({
  storeId: STORE_A, name: "Mercadinho A",
  users: [{ username:"gerentea", name:"Gerente A", role:"gerente", canAddStock:true, passHash: passHash("segredo123") }],
  products: []
});
seedFakeStore({
  storeId: STORE_B, name: "Mercadinho B",
  users: [{ username:"gerenteb", name:"Gerente B", role:"gerente", canAddStock:true, passHash: passHash("outrasenha") }],
  products: []
});

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

const ctxA = await browser.newContext();
await wireFakeCloud(ctxA);
const pageA = await ctxA.newPage();
const errorsA = [];
pageA.on("pageerror", e => errorsA.push("pageerror: " + e.message));

await pageA.goto(BASE);
await pageA.fill("#loginUser", "gerentea");
await pageA.fill("#loginPass", "segredo123");
await pageA.click("#loginBtn");
await pageA.waitForSelector("#gerente.is-active", { timeout: 8000 });
await pageA.click("#tabUsuarios");

check("tela de gerência não oferece mais criar 'gerente' (select removido)", (await pageA.locator("#nu_role").count()) === 0);

/* ---- cadastro de caixa herda a empresa do gerente logado ---- */
await pageA.fill("#nu_name", "Caixa Novo");
await pageA.fill("#nu_user", "caixanovo");
await pageA.fill("#nu_pass", "1234");
await pageA.click("#addUserBtn");
await pageA.waitForFunction(() => DB.users.some(u => u.username === "caixanovo"), null, { timeout: 8000 });
check("caixa aparece na lista da gerência após cadastro", true);

const created = peekFakeDb().operators.find(o => o.username === "caixanovo");
check("caixa foi gravado na nuvem", !!created);
check("caixa herdou automaticamente a empresa do gerente (store_id)", created && created.store_id === STORE_A,
  "store_id=" + (created && created.store_id));
check("caixa criado pela gerência nunca vira 'gerente'", created && created.role === "operador");

/* ---- o novo caixa loga em outro aparelho e cai na empresa certa ---- */
const ctxCashier = await browser.newContext();
await wireFakeCloud(ctxCashier);
const pageCashier = await ctxCashier.newPage();
await pageCashier.goto(BASE);
await pageCashier.fill("#loginUser", "caixanovo");
await pageCashier.fill("#loginPass", "1234");
await pageCashier.click("#loginBtn");
await pageCashier.waitForSelector("#operador.is-active", { timeout: 8000 });
check("caixa recém-criado loga normalmente e roteia para a empresa do gerente", true);
await ctxCashier.close();

/* ---- gerente ajusta a permissão de estoque do caixa que criou ---- */
await pageA.check(`.urow[data-username="caixanovo"] input[data-act="togglestock"]`);
const t0 = Date.now();
while (Date.now() - t0 < 5000 && !(peekFakeDb().operators.find(o => o.username === "caixanovo") || {}).can_add_stock) {
  await new Promise(r => setTimeout(r, 50));
}
check("permissão de estoque do caixa foi salva na nuvem",
  !!(peekFakeDb().operators.find(o => o.username === "caixanovo") || {}).can_add_stock);

/* ---- gerente NÃO consegue excluir/editar conta de gerente pela tela
   de gerência (só o admin da plataforma pode) ---- */
check("botão de excluir some para linhas de gerente", (await pageA.locator(`.urow[data-username="gerentea"] [data-act="deluser"]:not([disabled])`).count()) === 0);

/* ---- exclusão do caixa ---- */
await pageA.click(`.urow[data-username="caixanovo"] [data-act="deluser"]`);
await pageA.click("#confirmYes");
await pageA.waitForFunction(() => !DB.users.some(u => u.username === "caixanovo"), null, { timeout: 8000 });
check("caixa removido também na nuvem", !peekFakeDb().operators.some(o => o.username === "caixanovo"));

/* ---- isolamento entre empresas: mesmo pulando a UI e chamando a RPC
   direto (o pior caso — alguém adulterando o cliente), o gerente da
   empresa B não consegue mexer num caixa da empresa A, porque a RPC
   resolve a empresa no servidor a partir de quem está logado, nunca do
   parâmetro enviado pelo cliente ---- */
seedFakeStore({ storeId: STORE_A, name: "Mercadinho A", users: [
  { username:"caixaisolado", name:"Caixa Isolado", role:"operador", canAddStock:false, passHash: passHash("1234") }
], products: [] });

const ctxB = await browser.newContext();
await wireFakeCloud(ctxB);
const pageB = await ctxB.newPage();
await pageB.goto(BASE);
await pageB.fill("#loginUser", "gerenteb");
await pageB.fill("#loginPass", "outrasenha");
await pageB.click("#loginBtn");
await pageB.waitForSelector("#gerente.is-active", { timeout: 8000 });

const crossTenantResult = await pageB.evaluate(() => cloudDeleteCashier("caixaisolado"));
check("RPC recusa gerente mexer em caixa de OUTRA empresa", crossTenantResult && crossTenantResult.ok === false);
check("caixa da empresa A continua intacto", peekFakeDb().operators.some(o => o.username === "caixaisolado"));
await ctxB.close();

check("sem erros de JS (aparelho do gerente A)", errorsA.length === 0, errorsA.join(" | "));

await ctxA.close();
await browser.close();
if (failures) { console.error(`\n${failures} FALHA(S) NO CADASTRO DE CAIXA PELA GERÊNCIA`); process.exit(1); }
console.log("\nTODOS OS TESTES DE CADASTRO DE CAIXA PELA GERÊNCIA PASSARAM");
