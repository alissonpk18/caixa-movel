"use strict";
/* ================================================================
   LEITOR DE CÓDIGO DE BARRAS
   ================================================================ */
const isDeniedErr = (err)=>{
  const s=((err&&err.name)||""+err).toLowerCase();
  return s.includes("notallowed")||s.includes("permission");
};
// leitor de código de barras: opção secundária, aberta sob demanda (modal),
// então a câmera só liga quando o operador realmente pede.
function openScanModal(){
  $("scanModal").classList.add("show");
  startScanner();
}
function closeScanModal(){
  $("scanModal").classList.remove("show");
  stopScanner();
}
function startScanner(){
  $("scanFallback").classList.remove("show");
  if(state.scanReady || state.scanStarting) return;
  state.scanStarting=true;

  // espera um stop pendente terminar antes de religar (corrida logout→login rápido)
  (state.scanStopping || Promise.resolve()).then(()=>{
    state.scanStopping=null;
    // 1ª escolha: BarcodeDetector nativo (rápido, sem dependência externa);
    // 2ª: html5-qrcode do CDN; 3ª: teclado manual.
    startNativeScanner().catch(err=>{
      if(isDeniedErr(err)){ state.scanStarting=false; showFallback("Permissão de câmera negada. Digite o código manualmente."); return; }
      startLibScanner();
    });
  });
}
async function startNativeScanner(){
  if(!("BarcodeDetector" in window)) throw new Error("unsupported");
  const wanted=["ean_13","ean_8","upc_a","upc_e","code_128","code_39","qr_code"];
  let supported=[];
  try{ supported=await window.BarcodeDetector.getSupportedFormats(); }catch(e){}
  const formats=wanted.filter(f=>supported.includes(f));
  if(!formats.length) throw new Error("unsupported");
  const stream=await navigator.mediaDevices.getUserMedia({ video:{ facingMode:"environment" }, audio:false });
  const video=document.createElement("video");
  video.setAttribute("playsinline",""); video.muted=true; video.srcObject=stream;
  video.style.cssText="width:100%;height:100%;object-fit:cover";
  $("reader").innerHTML=""; $("reader").appendChild(video);
  await video.play();
  const detector=new window.BarcodeDetector({ formats });
  state.native={ stream, video, timer:0 };
  const tick=async ()=>{
    const n=state.native; if(!n) return;
    try{
      const found=await detector.detect(n.video);
      if(found && found.length && found[0].rawValue) onScan(String(found[0].rawValue));
    }catch(e){ /* quadro ainda não pronto: tenta no próximo tick */ }
    if(state.native) state.native.timer=setTimeout(tick,140);
  };
  tick();
  state.scanReady=true; state.scanStarting=false;
  // se o usuário saiu do caixa enquanto a câmera abria, desliga na hora
  if(!$("operador").classList.contains("is-active")) stopScanner();
}
function startLibScanner(){
  if(typeof Html5Qrcode==="undefined"){
    state.scanStarting=false;
    showFallback("Leitor de câmera não carregou. Digite o código manualmente.");
    return;
  }
  const fmts = window.Html5QrcodeSupportedFormats ? [
    Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
    Html5QrcodeSupportedFormats.UPC_A,  Html5QrcodeSupportedFormats.UPC_E,
    Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39,
    Html5QrcodeSupportedFormats.QR_CODE
  ] : undefined;

  try{ state.scanner = state.scanner || new Html5Qrcode("reader",{ formatsToSupport:fmts, verbose:false }); }
  catch(e){ state.scanStarting=false; showFallback("Não foi possível iniciar o leitor."); return; }

  state.scanner.start(
    { facingMode:"environment" },
    { fps:10, qrbox:(w,h)=>{ const m=Math.min(w,h); return {width:Math.floor(m*0.78), height:120}; } },
    onScan,
    ()=>{}
  ).then(()=>{
    state.scanReady=true; state.scanStarting=false;
    if(!$("operador").classList.contains("is-active")) stopScanner();
  }).catch(err=>{
    state.scanStarting=false;
    showFallback(isDeniedErr(err) ? "Permissão de câmera negada. Digite o código manualmente." : "Câmera indisponível. Digite o código manualmente.");
  });
}
function showFallback(msg){
  state.scanReady=false;
  $("fallbackMsg").textContent=msg||"Câmera indisponível. Digite o código manualmente.";
  $("scanFallback").classList.add("show");
}
function stopScanner(){
  if(state.native){
    const n=state.native; state.native=null;
    clearTimeout(n.timer);
    try{ n.stream.getTracks().forEach(t=>t.stop()); }catch(e){}
    try{ n.video.remove(); }catch(e){}
    state.scanStopping=Promise.resolve();
  }else if(state.scanner && state.scanReady){
    const sc=state.scanner;
    state.scanStopping = sc.stop().then(()=>{ try{sc.clear();}catch(e){} }).catch(()=>{});
  }
  state.scanReady=false;
}
// enquanto um código está na frente da câmera o leitor dispara vários quadros por segundo;
// só reaceitamos o MESMO código depois que ele some por um instante (intervalo sem leituras)
// e reaparece — isso indica um novo item físico, permitindo escanear 2+ unidades iguais.
const SCAN_REPEAT_GAP=500;
function onScan(code){
  const now=Date.now();
  const same=code===state.lastScan.code;
  const gap=now-state.lastScan.t;      // tempo desde a última leitura (de qualquer código)
  state.lastScan={code, t:now};        // atualiza o "último visto" em toda leitura
  // mesmo código ainda na frente da câmera (quadros seguidos): ignora para não multiplicar
  if(same && gap<SCAN_REPEAT_GAP) return;
  addByCode(code);
}

