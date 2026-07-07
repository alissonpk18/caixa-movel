/* Supabase falso para os E2E — em memória, persistido em localStorage
   (sobrevive a reload = simula outro aparelho / outra aba na mesma loja).
   Implementa o subconjunto usado por js/cloud.js e js/admin.js, incluindo
   uma simulação de RLS: cada conta vê a própria loja; contas presentes
   em `admins` veem tudo (como as políticas de supabase/schema.sql). */
export const FAKE_LIB = `
window.supabase = { createClient: function(){
  const load = () => JSON.parse(localStorage.getItem("fake:db") || '{"stores":[],"products":[],"sales":[],"kv":[],"admins":[],"n":1}');
  const save = (d) => localStorage.setItem("fake:db", JSON.stringify(d));
  const sess = () => JSON.parse(localStorage.getItem("fake:session") || "null");
  const auth = {
    async getSession(){ return { data: { session: sess() } }; },
    async signUp({email}){ localStorage.setItem("fake:session", JSON.stringify({user:{id:"u-"+email, email}})); return { data:{ session: sess() }, error:null }; },
    async signInWithPassword({email}){ localStorage.setItem("fake:session", JSON.stringify({user:{id:"u-"+email, email}})); return { data:{ session: sess() }, error:null }; },
    async signOut(){ localStorage.removeItem("fake:session"); return { error:null }; }
  };
  const keyOf = (t,r) => t==="stores" ? r.id : t==="admins" ? r.user_id : t==="products" ? r.store_id+"|"+r.code : t==="sales" ? r.store_id+"|"+r.id : r.store_id+"|"+r.key;
  function from(t){
    const q = { op:"select", rows:null, eq:[], not:null, single:false, maybe:false };
    const api = {
      select(){ return api; },
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
      const admin = (db.admins||[]).some(a=>a.user_id===uidv);          // is_admin()
      const my = (db.stores.find(x=>x.owner===uidv)||{}).id;
      const visible = r =>                                              // "RLS"
        t==="admins" ? r.user_id===uidv :
        t==="stores" ? (r.owner===uidv || admin) :
        (r.store_id===my || admin);
      if(q.op==="insert" || q.op==="upsert"){
        q.rows.forEach(r=>{
          const isNew = !rows.some(x=>keyOf(t,x)===keyOf(t,r)) ;
          if(t==="stores" && isNew){ r.id = r.id || ("store-"+(db.n++)); r.owner = r.owner || uidv; }
          const i = rows.findIndex(x=>keyOf(t,x)===keyOf(t,r));
          if(i>=0){ if(q.op==="upsert") rows[i]=Object.assign({}, rows[i], r); }
          else rows.push(r);
        });
        db[t]=rows; save(db);
        const out = q.rows.map(r=>rows.find(x=>keyOf(t,x)===keyOf(t,r))).filter(Boolean).filter(visible);
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

export const FAKE_CONFIG = '"use strict"; const CLOUD_CONFIG = { url: "https://fake.supabase.co", anonKey: "fake-key" };';

/* instala as rotas que ligam o modo nuvem falso num contexto Playwright */
export async function wireFakeCloud(ctx){
  await ctx.route("**/js/config.js", route => route.fulfill({ contentType:"application/javascript", body: FAKE_CONFIG }));
  await ctx.route("**cdn.jsdelivr.net/npm/@supabase/**", route => route.fulfill({ contentType:"application/javascript", body: FAKE_LIB }));
}
