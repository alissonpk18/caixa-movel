/* Achado A-12 do relatório de arquitetura: APP_VERSION (js/helpers.js) e
   CACHE (sw.js) são editados à mão e nada garantia que ficassem em
   sincronia; a lista de precache (sw.js → ASSETS) também é manual e um
   arquivo esquecido ali só quebra offline, silenciosamente. Este teste
   fecha as duas lacunas com leitura estática dos arquivos — sem DOM,
   sem servidor, sem Playwright. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

test("versão do app e nome do cache do service worker apontam para o mesmo número", () => {
  const helpers = read("js/helpers.js");
  const sw = read("sw.js");
  const appVersion = helpers.match(/APP_VERSION\s*=\s*"v(\d+)"/);
  const cacheVersion = sw.match(/const CACHE\s*=\s*"pdv-cache-v(\d+)"/);
  assert.ok(appVersion, "APP_VERSION não encontrado em js/helpers.js");
  assert.ok(cacheVersion, "CACHE não encontrado em sw.js");
  assert.equal(appVersion[1], cacheVersion[1],
    `APP_VERSION (v${appVersion[1]}) e CACHE (pdv-cache-v${cacheVersion[1]}) divergem — bump os dois juntos`);
});

test("todo script/estilo local referenciado no HTML está no precache do service worker", () => {
  const sw = read("sw.js");
  const assetsBlock = sw.match(/const ASSETS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(assetsBlock, "ASSETS não encontrado em sw.js");
  const assets = new Set([...assetsBlock[1].matchAll(/"([^"]+)"/g)].map(m => m[1]));

  for (const page of ["pdv-mobile.html", "admin.html"]) {
    const html = read(page);
    const refs = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map(m => m[1]);
    for (const ref of refs) {
      assert.ok(assets.has(ref), `${page} referencia "${ref}", ausente de sw.js → ASSETS`);
    }
  }
});
