# PDV · Caixa Rápido

Ponto de venda (PDV) mobile, leve e **100% client-side**, com leitor de código de
barras pela câmera, controle de estoque e relatórios de vendas. Funciona como
**PWA**: dá para instalar no celular e usar **offline**.

> Aplicativo de uma página (SPA) em HTML/CSS/JavaScript puro, sem build e sem backend.

## Funcionalidades

- **Login** com perfis de **operador** (caixa) e **gerência**.
- **Caixa**: leitura de código de barras pela câmera (com fallback de teclado
  manual), carrinho com ajuste de quantidade e validação de estoque.
- **Pagamento**: Dinheiro (com cálculo de **troco**), Cartão e Pix, com
  **comprovante** imprimível.
- **Gerência**:
  - Estoque: cadastrar, **editar nome/preço/quantidade** e **excluir** produtos,
    com **busca** e **alerta de estoque baixo configurável**.
  - **Controle de validade**: cada produto pode ter uma **data de validade**;
    o app destaca itens **vencidos** e **a vencer**, mostra um **resumo no topo
    do estoque** e permite ajustar **com quantos dias de antecedência** avisar.
  - Vendas: **histórico com filtro por data**, totais do período e
    **exportação para CSV**.
  - Usuários: **cadastrar caixas e gerentes**, definir login/senha e conceder a
    **permissão de adicionar itens ao estoque** a cada caixa (com remoção de
    usuários e travas para não excluir a si mesmo nem o último gerente).
- **Reposição pelo caixa**: o operador com a permissão liberada ganha o botão
  **"+Estoque"** para lançar entradas de mercadoria em produtos já cadastrados,
  podendo informar a **validade da mercadoria que entrou**.
- **Persistência**: `localStorage` (ou `window.storage` em ambiente de artifact);
  cai para memória apenas se nenhum estiver disponível (com aviso na tela).
- **Sessão persistente** e **sincronização entre abas**.

## Como usar

Abra o `pdv-mobile.html` por um servidor **HTTP(S)** (necessário para câmera,
service worker e instalação como app). Exemplos:

```bash
# Python
python3 -m http.server 8080
# depois acesse http://localhost:8080/pdv-mobile.html
```

Ou publique numa hospedagem estática (ex.: **GitHub Pages**) e acesse a URL.

### Credenciais de demonstração

| Perfil    | Usuário   | Senha |
|-----------|-----------|-------|
| Gerência  | `gerente` | `1234`|
| Caixa     | `caixa`   | `1234`|

### Instalar no celular (PWA)

Abra a URL no navegador do celular e use **"Adicionar à tela inicial"**. Após a
primeira visita, o app abre **offline**.

## Estrutura

| Arquivo                    | Função                                         |
|----------------------------|------------------------------------------------|
| `pdv-mobile.html`          | App completo (UI + lógica).                     |
| `manifest.webmanifest`     | Metadados do PWA.                               |
| `sw.js`                    | Service worker (cache/offline).                |
| `icon-*.png`               | Ícones do app.                                  |

## Limitações (por ser uma demo client-side)

- **Autenticação** é apenas demonstrativa (sem backend; senhas no cliente). Não
  use as credenciais padrão em produção.
- Os dados ficam **no dispositivo/navegador** — não há sincronização em nuvem
  nem entre aparelhos diferentes.
- A câmera exige **HTTPS** (ou `localhost`) e permissão do usuário.

## Tecnologias

- HTML/CSS/JS puro, sem dependências de build.
- [html5-qrcode](https://github.com/mebjas/html5-qrcode) (via CDN, com
  verificação de integridade **SRI**) para a leitura de código de barras.
