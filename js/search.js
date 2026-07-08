"use strict";
/* ================================================================
   BUSCA DE PRODUTOS (opção principal para adicionar itens, estilo
   "buscar no cardápio" — a câmera vira uma opção secundária)
   ================================================================ */
let searchQuery="";

function searchProducts(query){
  const q=query.trim().toLowerCase();
  if(!q) return [];
  return DB.products.filter(p=>p.name.toLowerCase().includes(q)||p.code.includes(q)).slice(0,30);
}

// desconta o que já está no carrinho: mostra quanto ainda dá pra adicionar
function searchAvailableQty(p){
  const inCart=state.cart.find(i=>i.code===p.code);
  return p.qty-(inCart?inCart.qty:0);
}

function renderSearchItem(p){
  const avail=searchAvailableQty(p);
  const out=avail<=0;
  return `
    <button type="button" class="search-item${out?" out":""}" data-code="${escapeHtml(p.code)}"${out?" disabled":""}>
      <span class="si-info">
        <span class="si-name">${escapeHtml(p.name)}</span>
        <span class="si-meta">
          <span class="si-price">${money(p.price)}</span>
          <span class="si-stock">${out?"Sem estoque disponível":avail+" un. em estoque"}</span>
        </span>
      </span>
      <span class="si-add" aria-hidden="true">+</span>
    </button>`;
}

function renderSearch(){
  const has=searchQuery.trim().length>0;
  $("searchClear").style.display = has ? "" : "none";
  $("searchResults").style.display = has ? "block" : "none";
  if(!has){
    $("cartList").style.display="";
    $("searchResults").innerHTML="";
    renderCart(); // reafirma o estado normal do carrinho (vazio ou com itens)
    return;
  }
  $("cartEmpty").style.display="none";
  $("cartList").style.display="none";
  const results=searchProducts(searchQuery);
  $("searchResults").innerHTML = results.length
    ? results.map(renderSearchItem).join("")
    : `<div class="cart-empty" style="display:flex"><div class="ico">🔎</div><p>Nenhum produto encontrado para "${escapeHtml(searchQuery.trim())}".</p></div>`;
}

function resetSearch(){
  searchQuery="";
  $("prodSearch2").value="";
  renderSearch();
}
