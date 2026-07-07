"use strict";
/* ---------- som (beep curto) ---------- */
function initAudio(){
  if(state.audio) return; // o beep é informação, não animação — independe de reduced-motion
  try{ state.audio = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){ state.audio=null; }
}
function beep(type){
  if(state.muted || !state.audio) return;
  try{
    const ctx = state.audio; if(ctx.state==="suspended") ctx.resume();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = type==="bad" ? 220 : 880;
    o.type = "sine";
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime+0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+(type==="bad"?0.22:0.12));
    o.start(); o.stop(ctx.currentTime+(type==="bad"?0.23:0.13));
  }catch(e){}
}

/* ---------- toast + status ---------- */
let toastT;
function toast(msg,type){
  const t=$("toast"); t.textContent=msg; t.className="show "+(type||"");
  clearTimeout(toastT); toastT=setTimeout(()=>t.className=t.className.replace("show","").trim(),2200);
}
let statusT;
function setStatus(text,type){
  const s=$("statusStrip"); $("statusText").textContent=text;
  s.className=type||"";
  if(type){ clearTimeout(statusT); statusT=setTimeout(()=>{ s.className=""; $("statusText").textContent="Pronto para ler"; },2600); }
}

