/* E2E do modo nuvem (SaaS) — roda SEM Supabase real:
   - intercepta js/config.js para devolver uma configuração preenchida;
   - intercepta a lib da nuvem e serve um Supabase falso em memória,
     persistido em localStorage (sobrevive a reload = simula a mesma
     loja aberta em "outro aparelho").
   Valida: modo local intocado sem config; signup; seed da loja vazia;
   push de venda; pull completo num "segundo aparelho". */
import { chromium } from "playwright";

const BASE = (process.env.PDV_URL || "http://localhost:8899") + "/pdv-mobile.html";
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
};

const FAKE_LIB = `
window.supabase = { createClient: function(){
  const load = () => JSON.parse(localStorage.getItem("fake:db") || '{"stores":[],"products":[],"sales":[],"kv":[],"n":1}');
  const save = (d) => localStorage.setItem("fake:db", JSON.stringify(d));
  const sess = () => JSON.parse(localStorage.getItem("fake:session") || "null");
  const auth = {
    async getSession(){ return { data: { session: sess() } }; },
    async signUp({email}){ localStorage.setItem("fake:session", JSON.stringify({user:{id:"u-"+email, email}})); return { data:{ session: sess() }, error:null }; },
    async signInWithPassword({email}){ localStorage.setItem("fake:session", JSON.stringify({user:{id:"u-"+email, email}})); return { data:{ session: sess() }, error:null }; },
    async signOut(){ localStorage.removeItem("fake:session"); return { error:null }; }
  };
  const keyOf = (t,r) => t==="stores" ? r.id : t==="products" ? r.store_id+"|"+r.code : t==="sales" ? r.store_id+"|"+r.id : r.store_id+"|"+r.key;
  function from(t){
    const q = { op:"select", rows:null, eq:[], not:null, single:false, maybe:false };
    const api = {
      select(){ if(q.op==="select") q.op="select"; return api; },
      insert(r){ q.op="insert"; q.rows=Array.isArray(r)?r:[r]; return api; },
      upsert(r){ q.op="upsert"; q.rows=Array.isArray(r)?r:[r]; return api; },
      delete(){ q.op="delete"; return api; },
      eq(c,v){ q.eq.push([c,v]); return api; },
      not(c,o,v){ q.not=[c,o,v]; return api; },
      order(){ return api; }, limit(){ return api; },
      maybeSingle(){ q.maybe=true; return api; },
      single(){ q.single=true; return api; },
      then(res,rej){ return Promise.resolve(exec()).then(res,rej); }
    };
    function exec(){
      const db = load(); let rows = db[t] || [];
      const s = sess(); const uidv = s && s.user.id;
      if(!uidv) return { data:null, error:{ message:"not authenticated" } };
      const my = (db.stores.find(x=>x.owner===uidv)||{}).id;
      const visible = r => t==="stores" ? r.owner===uidv : r.store_id===my;   // "RLS"
      if(q.op==="insert" || q.op==="upsert"){
        q.rows.forEach(r=>{
          if(t==="stores"){ r.id = r.id || ("store-"+(db.n++)); r.owner = uidv; }
          const k = keyOf(t,r);
          const i = rows.findIndex(x=>keyOf(t,x)===k);
          if(i>=0){ if(q.op==="upsert") rows[i]=Object.assign({}, rows[i], r); }
          else rows.push(r);
        });
        db[t]=rows; save(db);
        const out = q.rows.filter(visible);
        if(q.single) return { data: out[0]||null, error: out[0]?null:{message:"no rows"} };
        return { data: out, error:null };
      }
      let out = rows.filter(visible);
      q.eq.forEach(([c,v])=>{ out = out.filter(r=>r[c]===v); });
      if(q.not){
        const list = q.not[2].slice(1,-1).split(",").map(x=>x.replace(/^"|"$/g,""));
        out = out.filter(r=>!list.includes(String(r[q.not[0]])));
      }
      if(q.op==="delete"){
        const gone = new Set(out.map(r=>keyOf(t,r)));
        db[t] = rows.filter(r=>!gone.has(keyOf(t,r))); save(db);
        return { data:null, error:null };
      }
      if(q.maybe || q.single) return { data: out[0]||null, error: (q.single && !out[0])?{message:"no rows"}:null };
      return { data: out, error:null };
    }
    return api;
  }
  return { auth, from };
}};`;

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
await ctx.route("**/js/config.js", route => route.fulfill({
  contentType: "application/javascript",
  body: '"use strict"; const CLOUD_CONFIG = { url: "https://fake.supabase.co", anonKey: "fake-key" };'
}));
await ctx.route("**cdn.jsdelivr.net/npm/@supabase/**", route => route.fulfill({
  contentType: "application/javascript", body: FAKE_LIB
}));
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
