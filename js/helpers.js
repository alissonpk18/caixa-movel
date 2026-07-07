"use strict";
/* o núcleo é um arquivo local; se não carregou, algo está muito errado — avisa em vez de tela branca */
if(!window.PDV){
  document.body.innerHTML='<p style="padding:24px;font-family:sans-serif">Erro ao carregar o app (pdv-core.js). Recarregue a página.</p>';
  throw new Error("pdv-core.js ausente");
}
/* ================================================================
   PDV MOBILE — app de uma página só (SPA), tudo client-side.
   Persistência: usa o storage do artifact (window.storage) quando
   disponível; senão, roda em memória só nesta sessão (com aviso).
   ================================================================ */

/* Versão do app — mantenha em sincronia com CACHE do sw.js.
   Aparece no canto inferior direito para confirmar visualmente a atualização. */
const APP_VERSION = "v18";

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
(function(){ const b=document.getElementById("verBadge"); if(b) b.textContent=APP_VERSION; })();
const money = (v) => new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(v||0);
/* regras de negócio puras vêm do núcleo compartilhado (pdv-core.js) */
const {
  QTY_MAX, PRICE_MAX, round2, parseMoney, escapeHtml, csvCell, csvNum,
  isIsoDate, keyToIso, isoToKey, dateKey, daysUntilExp,
  sanitizeSettings, sanitizeUsers, sanitizeProducts, sanitizeCash,
  pixPayload, sessionSales, cashExpected, salesSummary, abcAnalysis, dailyAvgMap, daysOfStock
} = window.PDV;
const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "id-"+Date.now()+"-"+Math.random().toString(16).slice(2);
const sanitizeSales = (list) => window.PDV.sanitizeSales(list, uid);
const todayKey = (d=new Date()) => dateKey(d);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

