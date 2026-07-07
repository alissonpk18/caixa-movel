import { chromium } from "playwright";

const BASE = (process.env.PDV_URL || "http://localhost:8899") + "/pdv-mobile.html";
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
};

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
// modo local: aborta CDNs externos na hora, sem esperar a rede real
// falhar sozinha (fica rápido e determinístico em qualquer ambiente)
await ctx.route(/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/, route => route.abort());
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message));
page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });

// ---- 0. index.html redireciona para o app ----
await page.goto(BASE.replace("pdv-mobile.html",""));
await page.waitForURL("**/pdv-mobile.html", { timeout: 5000 });
check("index.html redireciona para pdv-mobile.html", true);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForTimeout(400);

// ---- 1. gerência: configurar Pix ----
await page.fill("#loginUser", "gerente");
await page.fill("#loginPass", "1234");
await page.click("#loginBtn");
await page.waitForSelector("#gerente.is-active", { timeout: 3000 });
await page.click("#tabVendas");
await page.fill("#pix_key", "loja@exemplo.com");
await page.fill("#pix_name", "Padaria do Zé");
await page.fill("#pix_city", "São Paulo");
await page.click("#pixSaveBtn");
await page.waitForTimeout(200);
const st = await page.evaluate(() => JSON.parse(localStorage.getItem("pdv:settings")));
check("config Pix persistida", st.pixKey === "loja@exemplo.com" && st.pixName === "Padaria do Zé", JSON.stringify(st));

// validação: chave vazia com nome preenchido é rejeitada
await page.fill("#pix_key", "");
await page.click("#pixSaveBtn");
check("config Pix sem chave é rejeitada", (await page.textContent("#pix_err")).includes("chave"));
await page.fill("#pix_key", "loja@exemplo.com");
await page.click("#pixSaveBtn");

// ---- 2. gerência: produto com custo ----
await page.click("#tabEstoque");
await page.fill("#np_code", "9990001112223");
await page.fill("#np_name", "Produto Margem");
await page.fill("#np_price", "10,00");
await page.fill("#np_qty", "50");
await page.fill("#np_cost", "6,00");
await page.click("#addProdBtn");
await page.waitForTimeout(200);
const pm = await page.evaluate(() => JSON.parse(localStorage.getItem("pdv:products")).find(p => p.code === "9990001112223"));
check("produto salvo com custo 6.00", !!pm && pm.cost === 6, JSON.stringify(pm));

// ---- 3. caixa: leitor físico (keyboard wedge) ----
await page.click("#logoutGer");
await page.waitForSelector("#login.is-active");
await page.fill("#loginUser", "caixa");
await page.fill("#loginPass", "1234");
await page.click("#loginBtn");
await page.waitForSelector("#operador.is-active", { timeout: 3000 });
await page.waitForTimeout(500);
await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
await page.keyboard.type("9990001112223", { delay: 10 });
await page.keyboard.press("Enter");
await page.waitForTimeout(250);
const cart1 = await page.evaluate(() => state.cart.map(i => i.code + ":" + i.qty).join(","));
check("leitor físico adiciona item ao carrinho", cart1 === "9990001112223:1", cart1);

// ---- 4. abrir caixa com fundo de troco ----
await page.click("#cashBtn");
await page.waitForSelector("#cashModal.show");
await page.fill("#cash_float", "50");
await page.click("#cashOpenBtn");
await page.waitForTimeout(200);
const cash1 = await page.evaluate(() => JSON.parse(localStorage.getItem("pdv:cash")));
check("caixa aberto com fundo 50", !!cash1.open && cash1.open.openingFloat === 50, JSON.stringify(cash1.open));
await page.click("#cashDismiss2");

// ---- 5. venda em dinheiro entra na gaveta ----
await page.click("#finalizeBtn");
await page.waitForSelector("#payModal.show");
await page.fill("#payReceived", "20");
await page.click("#payConfirm");
await page.waitForTimeout(300);
await page.click("#receiptClose");
const expected1 = await page.evaluate(() =>
  PDV.cashExpected(JSON.parse(localStorage.getItem("pdv:cash")).open, JSON.parse(localStorage.getItem("pdv:sales"))));
check("esperado na gaveta = 50 + 10 (venda dinheiro)", expected1 === 60, String(expected1));

// ---- 6. venda Pix: QR + copia e cola com CRC válido ----
await page.evaluate(() => addByCode("9990001112223"));
await page.click("#finalizeBtn");
await page.waitForSelector("#payModal.show");
await page.click('#payMethods [data-m="pix"]');
await page.waitForTimeout(200);
const pix = await page.evaluate(() => {
  const code = document.getElementById("pixCode").textContent;
  return {
    code,
    hasQr: !!document.querySelector("#pixQr svg"),
    crcOk: code.length > 8 && code.slice(-4) === PDV.crc16(code.slice(0, -4)),
    copyVisible: document.getElementById("pixCopyBtn").style.display !== "none"
  };
});
check("payload Pix começa com 000201 e tem o valor", pix.code.startsWith("000201") && pix.code.includes("540510.00"), pix.code.slice(0, 40));
check("QR code SVG renderizado", pix.hasQr);
check("CRC-16 do payload confere", pix.crcOk);
check("botão copiar visível", pix.copyVisible);
await page.click("#pixCopyBtn");
await page.waitForTimeout(200);
const clip = await page.evaluate(() => navigator.clipboard.readText());
check("copia e cola vai para a área de transferência", clip === pix.code);
await page.click("#payConfirm");
await page.waitForTimeout(300);
const lastSale = await page.evaluate(() => JSON.parse(localStorage.getItem("pdv:sales"))[0]);
check("venda registrada como Pix", lastSale.payment.method === "pix", JSON.stringify(lastSale.payment));

// ---- 7. compartilhar comprovante (fallback clipboard) ----
await page.evaluate(() => { navigator.share = undefined; });
await page.click("#receiptShare");
await page.waitForTimeout(200);
const clip2 = await page.evaluate(() => navigator.clipboard.readText());
check("comprovante copiado com total", clip2.includes("TOTAL") && clip2.includes("10,00"), clip2.slice(0, 80));
await page.click("#receiptClose");

// ---- 8. sangria e fechamento com conferência ----
await page.click("#cashBtn");
await page.waitForSelector("#cashModal.show");
await page.fill("#cash_mov", "20");
await page.click("#cashSangria");
await page.waitForTimeout(200);
const expected2 = await page.evaluate(() =>
  PDV.cashExpected(JSON.parse(localStorage.getItem("pdv:cash")).open, JSON.parse(localStorage.getItem("pdv:sales"))));
check("sangria de 20 abate da gaveta (60→40)", expected2 === 40, String(expected2));
// sangria maior que a gaveta é recusada
await page.fill("#cash_mov", "9999");
await page.click("#cashSangria");
check("sangria acima do esperado é recusada", (await page.textContent("#cash_err2")).includes("maior"));
await page.click("#cashStartClose");
await page.fill("#cash_counted", "40,00");
await page.click("#cashConfirmClose");
await page.waitForTimeout(300);
const cash2 = await page.evaluate(() => JSON.parse(localStorage.getItem("pdv:cash")));
check("fechamento registrado sem diferença", cash2.open === null && cash2.history.length === 1 && cash2.history[0].diff === 0, JSON.stringify(cash2.history[0]));

// ---- 9. gerência: ABC, ticket médio e histórico de caixa ----
await page.click("#logoutOp");
await page.waitForSelector("#login.is-active");
await page.fill("#loginUser", "gerente");
await page.fill("#loginPass", "1234");
await page.click("#loginBtn");
await page.waitForSelector("#gerente.is-active");
await page.click("#tabVendas");
await page.waitForTimeout(200);
const rep = await page.evaluate(() => ({
  summary: document.getElementById("salesSummary").textContent,
  abc: document.getElementById("abcList").textContent,
  hist: document.getElementById("cashHistList").textContent
}));
check("resumo mostra ticket médio", rep.summary.includes("ticket médio"), rep.summary);
check("curva ABC lista o produto com lucro", rep.abc.includes("Produto Margem") && rep.abc.includes("lucro"), rep.abc.slice(0, 120));
check("histórico de fechamentos aparece na gerência", rep.hist.includes("Caixa 1"), rep.hist.slice(0, 120));

// ---- 10. previsão de reposição no estoque ----
// vendeu 2 un em 14 dias (~0,14/dia); com 2 un restantes o estoque dura ~14 dias → deve avisar
await page.click("#tabEstoque");
await page.evaluate(() => {
  const p = DB.products.find(x => x.code === "9990001112223");
  p.qty = 2; saveProducts(); renderStock();
});
await page.waitForTimeout(200);
const stockTxt = await page.evaluate(() => document.getElementById("prodList").textContent);
check("aviso de reposição aparece quando o estoque dura ≤14 dias", /estoque p\/ ~\d+ dias?/.test(stockTxt), stockTxt.slice(0, 150));
const stockTxt2 = await page.evaluate(() => {
  const p = DB.products.find(x => x.code === "9990001112223");
  p.qty = 480; saveProducts(); renderStock(); // estoque para ~10 anos: sem aviso
  return document.getElementById("prodList").textContent;
});
check("sem aviso quando o estoque é folgado", !/estoque p\/ ~\d+ dias?/.test(stockTxt2));

// ---- 11. backup: exportar, corromper, importar e restaurar ----
const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.click("#tabUsuarios").then(() => page.click("#backupExport"))
]);
const bkPath = new URL("./backup-test.json", import.meta.url).pathname;
await download.saveAs(bkPath);
check("backup exportado", true);
// perde dados de propósito
await page.evaluate(() => { localStorage.setItem("pdv:products", "[]"); });
await page.reload();
await page.waitForSelector("#gerente.is-active", { timeout: 4000 });
const lost = await page.evaluate(() => JSON.parse(localStorage.getItem("pdv:products")).length);
check("produtos apagados para o teste", lost === 0, String(lost));
await page.click("#tabUsuarios");
await page.setInputFiles("#backupFile", bkPath);
await page.waitForSelector("#confirmModal.show", { timeout: 3000 });
await page.click("#confirmYes");
await page.waitForTimeout(400);
const restored = await page.evaluate(() => {
  const prods = JSON.parse(localStorage.getItem("pdv:products"));
  const cash = JSON.parse(localStorage.getItem("pdv:cash"));
  const st = JSON.parse(localStorage.getItem("pdv:settings"));
  return { n: prods.length, margem: prods.some(p => p.code === "9990001112223" && p.cost === 6), hist: cash.history.length, pix: st.pixKey };
});
check("backup restaurou produtos, caixa e Pix", restored.n > 0 && restored.margem && restored.hist === 1 && restored.pix === "loja@exemplo.com", JSON.stringify(restored));

// ---- erros de página ----
const realErrors = errors.filter(e => !/camera|NotFound|NotAllowed|getUserMedia|videoinput|Requested device|Failed to load resource/i.test(e));
check("sem erros de JS no console", realErrors.length === 0, realErrors.join(" | "));

await browser.close();
console.log(failures ? `\n${failures} FALHA(S)` : "\nTODOS OS TESTES DE FEATURES PASSARAM");
process.exit(failures ? 1 : 0);
