/* Supabase falso para os E2E — sem rede real. O "banco" vive em memória
   NESTE processo Node (módulo compartilhado por todos os contextos de
   navegador do arquivo de teste), exposto às páginas via
   `context.exposeBinding` — assim vários "aparelhos" (contextos
   separados, cada um com seu próprio localStorage/sessão) enxergam o
   mesmo banco, igual ao Supabase de verdade. Só a sessão (qual
   identidade este aparelho usa) fica no localStorage de cada contexto.

   Implementa o subconjunto usado por js/cloud.js e js/admin.js:
   - auth.signInAnonymously(): identidade do aparelho (sem e-mail).
   - auth.signUp/signInWithPassword: login real, só usado pelo admin.html.
   - from(table): CRUD com uma simulação de RLS (cada aparelho só vê a
     própria empresa via device_links; is_admin() enxerga tudo).
   - rpc('login_operator', {p_username,p_hash}): espelha a função SQL em
     supabase/schema.sql — busca o username (chave única global) na
     tabela `operators`, confere o hash e, se bater, vincula o aparelho
     (device_links) e devolve o store_id.
   - rpc('apply_sale'|'adjust_stock'|'set_stock', ...): espelham as RPCs
     atômicas de estoque (achado A-02) — mutam DB.products.qty
     diretamente, e o upsert genérico de "products" (linha abaixo)
     ignora qty num UPDATE, exatamente como o gatilho protect_product_qty
     do banco real; só um INSERT (produto novo) define qty pelo upsert.
   - operators (achado A-03): username é chave PRIMÁRIA GLOBAL (não só
     dentro da empresa) — um INSERT com username repetido (em qualquer
     empresa) retorna erro, como a constraint única do banco real.
     Simplificação: a "RLS" de escrita aqui não distingue admin de
     aparelho comum para operators/device_links (no app real só o
     admin.js escreve nelas; nenhum teste tenta o caminho contrário). */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let DB = { stores:[], products:[], sales:[], kv:[], admins:[], device_links:[], operators:[], n:1 };

function keyOf(t,r){
  if(t==="stores") return r.id;
  if(t==="admins") return r.user_id;
  if(t==="device_links") return r.auth_uid;
  if(t==="operators") return r.username;
  if(t==="products") return r.store_id+"|"+r.code;
  if(t==="sales") return r.store_id+"|"+r.id;
  return r.store_id+"|"+r.key;
}

function handleFakeApi({ fn, uid, args }){
  if(fn==="rpc.login_operator"){
    if(!uid) return { data:[], error:null };
    const username = String(args.p_username).toLowerCase();
    const o = DB.operators.find(x=>x.username===username);
    if(!o || o.pass_hash !== args.p_hash) return { data:[], error:null };
    DB.device_links = DB.device_links.filter(x=>x.auth_uid!==uid);
    DB.device_links.push({ auth_uid:uid, store_id:o.store_id, username:args.p_username, linked_at:new Date().toISOString() });
    return { data:[{ store_id:o.store_id, name:o.name||"", role:o.role||"operador", can_add_stock:!!o.can_add_stock }], error:null };
  }
  if(fn==="rpc.apply_sale" || fn==="rpc.adjust_stock" || fn==="rpc.set_stock"){
    if(!uid) return { data:null, error:{ message:"not authenticated" } };
    const link = DB.device_links.find(x=>x.auth_uid===uid);
    const store_id = link && link.store_id;
    if(!store_id) return { data:null, error:{ message:"sem empresa vinculada" } };

    if(fn==="rpc.apply_sale"){
      const sale = args.p_sale;
      const already = DB.sales.some(s=>s.store_id===store_id && s.id===sale.id);
      if(!already){
        DB.sales.push({ store_id, id:sale.id, at:sale.ts, operator:sale.operator||"",
          method:(sale.payment&&sale.payment.method)||"", total:sale.total, data:sale });
        (sale.items||[]).forEach(it=>{
          const p = DB.products.find(x=>x.store_id===store_id && x.code===it.code);
          if(p) p.qty = Math.max(0, p.qty - (it.qty||0));
        });
      }
      return { data:null, error:null };
    }
    const p = DB.products.find(x=>x.store_id===store_id && x.code===args.p_code);
    if(p){
      if(fn==="rpc.adjust_stock") p.qty = Math.max(0, p.qty + args.p_delta);
      else p.qty = Math.max(0, args.p_qty);
    }
    return { data:null, error:null };
  }
  if(fn==="from.exec"){
    const { table:t, op, rows, eq, not, gt, patch, single, maybe } = args;
    if(!uid) return { data:null, error:{ message:"not authenticated" } };
    const admin = DB.admins.some(a=>a.user_id===uid);
    const myLink = DB.device_links.find(x=>x.auth_uid===uid);
    const my = (DB.stores.find(x=>x.owner===uid)||{}).id || (myLink && myLink.store_id);
    const visible = r =>
      t==="admins" ? r.user_id===uid :
      t==="stores" ? (r.owner===uid || admin) :
      t==="device_links" ? (r.auth_uid===uid || admin) :
      t==="operators" ? (r.store_id===my || admin) :
      (r.store_id===my || admin);
    const list = DB[t] || (DB[t]=[]);
    if(op==="insert" || op==="upsert"){
      let conflictErr = null;
      rows.forEach(r=>{
        const isNew = !list.some(x=>keyOf(t,x)===keyOf(t,r));
        if(t==="stores" && isNew){ r.id = r.id || ("store-"+(DB.n++)); }
        const i = list.findIndex(x=>keyOf(t,x)===keyOf(t,r));
        if(i>=0){
          if(op==="upsert"){
            const p = Object.assign({}, r);
            if(t==="products") delete p.qty; // simula o gatilho protect_product_qty
            list[i]=Object.assign({}, list[i], p);
          }else{
            // insert puro num registro que já existe: violação de chave
            // única/primária, como no banco real (ex.: username repetido)
            conflictErr = { message:"duplicate key value violates unique constraint", code:"23505" };
          }
        }
        else list.push(r);
      });
      if(conflictErr) return { data:null, error:conflictErr };
      const out = rows.map(r=>list.find(x=>keyOf(t,x)===keyOf(t,r))).filter(Boolean).filter(visible);
      if(single) return { data: out[0]||null, error: out[0]?null:{message:"no rows"} };
      return { data: out, error:null };
    }
    let out = list.filter(visible);
    (eq||[]).forEach(([c,v])=>{ out = out.filter(r=>r[c]===v); });
    if(gt) out = out.filter(r=>r[gt[0]] > gt[1]);
    if(not){
      const l = not[2].slice(1,-1).split(",").map(x=>x.replace(/^"|"$/g,""));
      out = out.filter(r=>!l.includes(String(r[not[0]])));
    }
    if(op==="update"){
      out.forEach(r=>Object.assign(r, patch));
      return { data:null, error:null };
    }
    if(op==="delete"){
      const gone = new Set(out.map(r=>keyOf(t,r)));
      DB[t] = list.filter(r=>!gone.has(keyOf(t,r)));
      return { data:null, error:null };
    }
    if(maybe || single) return { data: out[0]||null, error: (single && !out[0])?{message:"no rows"}:null };
    return { data: out, error:null };
  }
  return { data:null, error:{ message:"unknown fn "+fn } };
}

export const FAKE_LIB = `
window.supabase = { createClient: function(){
  const sess = () => JSON.parse(localStorage.getItem("fake:session") || "null");
  const setSess = (s) => localStorage.setItem("fake:session", JSON.stringify(s));
  const call = (fn, args) => window.__fakeApi({ fn, uid: (sess()&&sess().user.id)||null, args });
  const auth = {
    async getSession(){ return { data: { session: sess() } }; },
    async signInAnonymously(){
      if(!sess()) setSess({ user: { id: "anon-"+Math.random().toString(36).slice(2), email: null } });
      return { data: { session: sess() }, error: null };
    },
    async signUp({email}){ setSess({user:{id:"u-"+email, email}}); return { data:{ session: sess() }, error:null }; },
    async signInWithPassword({email}){ setSess({user:{id:"u-"+email, email}}); return { data:{ session: sess() }, error:null }; },
    async signOut(){ localStorage.removeItem("fake:session"); return { error:null }; }
  };
  function from(t){
    const q = { op:"select", rows:null, eq:[], not:null, gt:null, patch:null, single:false, maybe:false };
    const api = {
      select(){ return api; },
      insert(r){ q.op="insert"; q.rows=Array.isArray(r)?r:[r]; return api; },
      upsert(r){ q.op="upsert"; q.rows=Array.isArray(r)?r:[r]; return api; },
      update(p){ q.op="update"; q.patch=p; return api; },
      delete(){ q.op="delete"; return api; },
      eq(c,v){ q.eq.push([c,v]); return api; },
      not(c,o,v){ q.not=[c,o,v]; return api; },
      gt(c,v){ q.gt=[c,v]; return api; },
      order(){ return api; }, limit(){ return api; },
      maybeSingle(){ q.maybe=true; return api; },
      single(){ q.single=true; return api; },
      then(res,rej){ return call("from.exec", Object.assign({table:t}, q)).then(res,rej); }
    };
    return api;
  }
  async function rpc(name, args){
    if(!["login_operator","apply_sale","adjust_stock","set_stock"].includes(name)){
      return { data:null, error:{message:"unknown rpc"} };
    }
    return call("rpc."+name, args);
  }
  return { auth, from, rpc };
}};`;

export const FAKE_CONFIG = '"use strict"; const CLOUD_CONFIG = { url: "https://fake.supabase.co", anonKey: "fake-key" };';

/* js/cloud.js e js/admin.js carregam a lib da nuvem com verificação de
   integridade (SRI) contra o hash real do supabase-js — correto em
   produção, mas o navegador aplica essa checagem também sobre o corpo
   que o Playwright serve aqui, e o FAKE_LIB claramente não bate com o
   hash do pacote real. Em vez de remover a proteção do código de
   produção, os testes servem cloud.js/admin.js com a constante de SRI
   recalculada para o hash do PRÓPRIO conteúdo falso — a integridade
   continua sendo verificada de ponta a ponta, só que contra o corpo
   certo para este ambiente de teste. */
const FAKE_LIB_SRI = "sha384-" + createHash("sha384").update(FAKE_LIB, "utf8").digest("base64");
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
function patchedLibLoader(relPath, sriConstName){
  const src = readFileSync(join(REPO_ROOT, relPath), "utf8");
  const re = new RegExp(`(const ${sriConstName}\\s*=\\s*)"sha384-[^"]+"`);
  if(!re.test(src)) throw new Error(`${sriConstName} não encontrado em ${relPath} — arquivo mudou?`);
  return src.replace(re, `$1"${FAKE_LIB_SRI}"`);
}

/* instala as rotas/bindings que ligam o modo nuvem falso num contexto Playwright */
export async function wireFakeCloud(ctx){
  await ctx.route("**/js/config.js", route => route.fulfill({ contentType:"application/javascript", body: FAKE_CONFIG }));
  await ctx.route("**cdn.jsdelivr.net/npm/@supabase/**", route => route.fulfill({ contentType:"application/javascript", body: FAKE_LIB }));
  await ctx.route("**/js/cloud.js", route => route.fulfill({ contentType:"application/javascript", body: patchedLibLoader("js/cloud.js", "CLOUD_LIB_SRI") }));
  await ctx.route("**/js/admin.js", route => route.fulfill({ contentType:"application/javascript", body: patchedLibLoader("js/admin.js", "ADMIN_LIB_SRI") }));
  await ctx.exposeBinding("__fakeApi", (_source, payload) => handleFakeApi(payload));
}

/* semeia uma empresa direto no banco falso (equivalente a já ter sido
   criada e ter usuários cadastrados pelo admin.html) — usado pelos testes
   que não precisam dirigir a UI do admin para preparar o cenário.
   `users`: [{ username, name, role, canAddStock, passHash }] — mesmo
   formato usado no resto dos testes; vira uma linha em `operators`. */
export function seedFakeStore({ storeId, name, users, products }){
  DB.stores.push({ id: storeId, name, email:"", owner:null });
  (users||[]).forEach(u => DB.operators.push({
    username: u.username.toLowerCase(), store_id: storeId, name: u.name||"",
    role: u.role||"operador", can_add_stock: !!u.canAddStock, pass_hash: u.passHash
  }));
  (products||[]).forEach(p => DB.products.push(Object.assign({ store_id: storeId }, p)));
}

/* promove uma conta a administradora da plataforma (equivalente ao
   `insert into public.admins` do schema, feito manualmente pelo SQL). */
export function seedAdmin(email){
  DB.admins.push({ user_id: "u-"+email });
}

/* inspeciona o banco falso direto do Node (sem passar por localStorage
   de nenhum contexto — o banco agora é compartilhado entre eles). */
export function peekFakeDb(){ return DB; }
