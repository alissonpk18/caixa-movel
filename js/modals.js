"use strict";
/* ================================================================
   CONFIRMAÇÃO (sheet reutilizável)
   ================================================================ */
let confirmCb=null;
function askConfirm(title,msg,onYes,yesLabel){
  $("confirmTitle").textContent=title;
  $("confirmMsg").textContent=msg;
  $("confirmYes").textContent=yesLabel||"Confirmar";
  confirmCb=onYes;
  $("confirmModal").classList.add("show");
}
function closeConfirm(){ $("confirmModal").classList.remove("show"); confirmCb=null; }

/* ================================================================
   TECLADO MANUAL
   ================================================================ */
let manualBuf="";
function openManual(){ manualBuf=""; updateManual(); $("manualModal").classList.add("show"); }
function closeManual(){ $("manualModal").classList.remove("show"); }
function updateManual(){
  const d=$("manualDisplay");
  if(manualBuf){ d.textContent=manualBuf; d.classList.remove("empty"); }
  else{ d.textContent="código do produto"; d.classList.add("empty"); }
}

