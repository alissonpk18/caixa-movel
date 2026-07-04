import { chromium } from "playwright";

const BASE = (process.env.PDV_URL || "http://localhost:8899") + "/pdv-mobile.html";
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
};

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message));
page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });

await page.goto(BASE);
await page.waitForTimeout(400);

// ---- 1. login gerente ----
await page.fill("#loginUser", "gerente");
await page.fill("#loginPass", "1234");
await page.click("#loginBtn");
await page.waitForSelector("#gerente.is-active", { timeout: 3000 });
check("login gerente entra na tela de gerência", true);

// senha migrou para hash?
const users = await page.evaluate(() => JSON.parse(localStorage.getItem("pdv:users")));
const ger = users.find(u => u.username === "gerente");
check("senha do gerente migrou para passHash", !!ger.passHash && ger.password === undefined, JSON.stringify(ger));

// ---- 2. cadastro de produto: validações ----
await page.fill("#np_code", "1234567890123");
await page.fill("#np_name", "Produto Teste");
await page.fill("#np_price", "10000000");
await page.fill("#np_qty", "10");
await page.click("#addProdBtn");
check("preço acima do teto é rejeitado", (await page.textContent("#np_err")).includes("Preço"));
await page.fill("#np_price", "3,50");
await page.fill("#np_qty", "99999999");
await page.click("#addProdBtn");
check("quantidade acima do teto é rejeitada", (await page.textContent("#np_err")).includes("Quantidade"));
await page.fill("#np_qty", "10");
await page.click("#addProdBtn");
await page.waitForTimeout(200);
const prods = await page.evaluate(() => JSON.parse(localStorage.getItem("pdv:products")));
const novo = prods.find(p => p.code === "1234567890123");
check("produto cadastrado com preço 3.50", !!novo && novo.price === 3.5, JSON.stringify(novo));

// ---- 3. logout, login caixa ----
await page.click("#logoutGer");
await page.waitForSelector("#login.is-active");
await page.fill("#loginUser", "caixa");
await page.fill("#loginPass", "1234");
await page.click("#loginBtn");
await page.waitForSelector("#operador.is-active", { timeout: 3000 });
check("login caixa entra na tela do operador", true);
await page.waitForTimeout(600); // câmera falha no headless → fallback
check("fallback de câmera aparece sem câmera", await page.evaluate(() => document.getElementById("scanFallback").classList.contains("show")));

// ---- 4. venda: bug de ponto flutuante (3 × 5,49 = 16,47) ----
await page.evaluate(() => { addByCode("7891000100103"); addByCode("7891000100103"); });
// terceiro item via teclado manual (fluxo real de UI)
await page.click("#manualBtn2");
for (const d of "7891000100103") await page.click(`#keypad [data-k="${d}"]`);
await page.click("#manualSearch");
await page.waitForTimeout(200);
const totalTxt = await page.textContent("#cartTotal");
check("total do carrinho = R$ 16,47", totalTxt.replace(/ /g, " ").includes("16,47"), totalTxt);

await page.click("#finalizeBtn");
await page.waitForSelector("#payModal.show");
await page.fill("#payReceived", "16,47");
await page.waitForTimeout(100);
const troco = await page.textContent("#payChange");
check("troco exibido = R$ 0,00", troco.includes("0,00"), troco);
await page.click("#payConfirm");
await page.waitForTimeout(300);
check("pagamento exato em dinheiro é aceito (fix float)", await page.evaluate(() => document.getElementById("receiptModal").classList.contains("show")));
const sales = await page.evaluate(() => JSON.parse(localStorage.getItem("pdv:sales")));
check("venda registrada com total 16.47", sales.length === 1 && sales[0].total === 16.47, JSON.stringify(sales[0] && sales[0].total));
const prods2 = await page.evaluate(() => JSON.parse(localStorage.getItem("pdv:products")));
const bisc = prods2.find(p => p.code === "7891000100103");
check("estoque baixou de 40 para 37", bisc.qty === 37, String(bisc.qty));
await page.click("#receiptClose");

// ---- 5. troco com pagamento maior ----
await page.evaluate(() => addByCode("7891000100103"));
await page.click("#finalizeBtn");
await page.waitForSelector("#payModal.show");
await page.fill("#payReceived", "10");
await page.click("#payConfirm");
await page.waitForTimeout(300);
const rec = await page.textContent("#receiptBox");
check("troco de R$ 4,51 no comprovante", rec.includes("4,51"), rec.slice(0, 200));
await page.click("#receiptClose");

// ---- 6. valor insuficiente é recusado ----
await page.evaluate(() => addByCode("7891000100103"));
await page.click("#finalizeBtn");
await page.waitForSelector("#payModal.show");
await page.fill("#payReceived", "5,48");
await page.click("#payConfirm");
await page.waitForTimeout(200);
check("pagamento insuficiente mantém o modal aberto", await page.evaluate(() => document.getElementById("payModal").classList.contains("show")));
await page.click("#payClose");
await page.click("#cancelBtn");
await page.click("#confirmYes");

// ---- 7. storage corrompido não derruba o app ----
await page.evaluate(() => {
  localStorage.setItem("pdv:products", JSON.stringify([{ code: "111111", name: "OK", price: 1.5, qty: 3 }, { code: null, price: "x" }, "lixo", { code: "111111", name: "dup", price: 2, qty: 1 }]));
  localStorage.setItem("pdv:sales", JSON.stringify([{ bad: true }, null]));
  localStorage.setItem("pdv:users", "{corrompido");
  localStorage.setItem("pdv:settings", JSON.stringify({ lowStock: -5, expWarnDays: "x" }));
  localStorage.removeItem("pdv:session"); // sem sessão: reload deve cair no login
});
await page.reload();
await page.waitForTimeout(600);
const boot2 = await page.evaluate(() => ({
  users: DB.users.length, hasGer: DB.users.some(u => u.role === "gerente"),
  prods: DB.products.map(p => p.code), sales: DB.sales.length, low: settings.lowStock
}));
check("users corrompidos → seed restaurado com gerência", boot2.hasGer && boot2.users >= 2, JSON.stringify(boot2));
check("produtos: só o registro válido sobrevive (sem duplicata)", boot2.prods.length === 1 && boot2.prods[0] === "111111", JSON.stringify(boot2.prods));
check("vendas corrompidas viram lista vazia", boot2.sales === 0, String(boot2.sales));
check("settings inválidos mantêm padrão", boot2.low === 5, String(boot2.low));

// app continua utilizável após corrupção
await page.fill("#loginUser", "gerente");
await page.fill("#loginPass", "1234");
await page.click("#loginBtn");
await page.waitForSelector("#gerente.is-active", { timeout: 3000 });
check("login funciona após recuperação de dados corrompidos", true);

// ---- 8. usuários: cadastro com hash + exclusão travada ----
await page.click("#tabUsuarios");
await page.fill("#nu_name", "Caixa 2");
await page.fill("#nu_user", "caixa2");
await page.fill("#nu_pass", "abcd");
await page.click("#addUserBtn");
await page.waitForTimeout(300);
const users2 = await page.evaluate(() => JSON.parse(localStorage.getItem("pdv:users")));
const c2 = users2.find(u => u.username === "caixa2");
check("novo usuário salvo só com passHash", !!c2 && !!c2.passHash && c2.password === undefined, JSON.stringify(c2));

// login do novo usuário com senha hasheada
await page.click("#logoutGer");
await page.fill("#loginUser", "caixa2");
await page.fill("#loginPass", "abcd");
await page.click("#loginBtn");
await page.waitForSelector("#operador.is-active", { timeout: 3000 });
check("login com senha hasheada funciona", true);
await page.click("#logoutOp");
await page.waitForSelector("#login.is-active");

// senha errada é recusada
await page.fill("#loginUser", "caixa2");
await page.fill("#loginPass", "errada");
await page.click("#loginBtn");
await page.waitForTimeout(300);
check("senha errada é recusada", (await page.textContent("#loginErr")).includes("incorretos"));

// ---- 9. CSV com vírgula decimal ----
await page.fill("#loginUser", "gerente");
await page.fill("#loginPass", "1234");
await page.click("#loginBtn");
await page.waitForSelector("#gerente.is-active");
const csvOk = await page.evaluate(() => csvNum(16.47) === "16,47" && csvNum(5.5) === "5,50");
check("csvNum usa vírgula decimal", csvOk);

// ---- 10. parseMoney reforçado ----
const pm = await page.evaluate(() => [
  parseMoney("1.234,56") === 1234.56,
  parseMoney("R$ 5,49") === 5.49,
  parseMoney("5.49") === 5.49,
  isNaN(parseMoney("12,34,56")),
  isNaN(parseMoney("abc")),
  round2(5.49 * 3) === 16.47
]);
check("parseMoney/round2 cobrem os formatos e rejeitam lixo", pm.every(Boolean), JSON.stringify(pm));

// ---- erros de página ----
// ignora falhas de rede do sandbox (CDN bloqueado, favicon 404) — só erros de JS contam
const realErrors = errors.filter(e => !/camera|NotFound|NotAllowed|getUserMedia|videoinput|Requested device|Failed to load resource/i.test(e));
check("sem erros de JS no console", realErrors.length === 0, realErrors.join(" | "));

await browser.close();
console.log(failures ? `\n${failures} FALHA(S)` : "\nTODOS OS TESTES PASSARAM");
process.exit(failures ? 1 : 0);
