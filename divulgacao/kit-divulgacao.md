# Kit de divulgação — PDV · Caixa Rápido

Tudo pronto para copiar, colar e divulgar. Os textos estão em tom direto,
pensados para o dono de comércio pequeno (mercadinho, lanchonete, feira,
food truck, bazar, loja de bairro).

> **Antes de divulgar** (checklist rápido):
> 1. Publique o app numa URL (GitHub Pages: Settings → Pages → branch `main`).
>    A URL fica no formato `https://SEUUSUARIO.github.io/caixa-movel/`.
> 2. Abra a URL no celular e teste uma venda completa.
> 3. Troque as senhas padrão (`gerente/1234`, `caixa/1234`) se o link for público.
> 4. Substitua `[LINK]` nos textos abaixo pela sua URL.

---

## 1. Identidade

- **Nome:** PDV · Caixa Rápido
- **Slogan (opções):**
  - "Seu caixa no celular. Sem mensalidade, sem maquininha de sistema."
  - "Transforme qualquer celular em ponto de venda."
  - "Venda, receba no Pix e controle o estoque — direto do celular."
- **Descrição em 1 frase:** Ponto de venda gratuito que roda no navegador do
  celular: lê código de barras pela câmera, cobra no Pix com QR Code na hora,
  controla estoque e validade, e mostra relatórios de venda — funcionando até
  sem internet.

## 2. Pitch de 30 segundos (elevator pitch)

> Sabe aquele mercadinho que ainda anota venda em caderno porque sistema de
> PDV é caro? O Caixa Rápido transforma o celular que a pessoa já tem num
> ponto de venda completo: a câmera vira leitor de código de barras, o Pix sai
> com QR Code gerado na hora (sem taxa de intermediário), o estoque baixa
> sozinho a cada venda e a gerência vê faturamento, ticket médio e curva ABC.
> Não precisa instalar nada, não tem mensalidade e funciona offline — é abrir
> o link e vender.

## 3. Principais argumentos de venda (use em qualquer canal)

| Dor do lojista | Como o app resolve |
|---|---|
| "Sistema de PDV é caro" | Gratuito, sem mensalidade e sem taxa por venda |
| "Não tenho computador na loja" | Roda no celular, instala como app (PWA) |
| "Internet cai toda hora" | Funciona offline; sincroniza quando voltar |
| "Leitor de código é caro" | A câmera do celular lê o código de barras (e aceita leitor USB/Bluetooth se tiver) |
| "Taxa do Pix da maquininha dói" | QR Code Pix gerado no próprio aparelho, direto para a sua chave — sem intermediário |
| "Perco produto vencido" | Controle de validade com alerta de "vence em X dias" |
| "Não sei o que repor" | Alerta de estoque baixo + estimativa de "estoque para ~X dias" |
| "Não sei se estou lucrando" | Relatórios: faturamento, ticket médio, curva ABC com lucro por produto |
| "Funcionário mexe onde não deve" | Perfis separados de caixa e gerência, com permissões |
| "Preciso ver a loja de casa" | Modo nuvem opcional (Supabase) sincroniza vários aparelhos |

## 4. WhatsApp — mensagem curta (grupos e contatos)

```
🛒 Transformei o celular num caixa de loja!

O *PDV Caixa Rápido* é um ponto de venda GRATUITO que roda no navegador:

📷 Lê código de barras pela câmera
💰 Pix com QR Code na hora (sem taxa!)
📦 Baixa o estoque sozinho a cada venda
⏰ Avisa produto vencendo e estoque acabando
📊 Relatório de vendas, ticket médio e lucro

Sem mensalidade, sem instalar nada, funciona até SEM INTERNET.

Testa aí (entre com gerente/1234): [LINK]
```

## 5. Instagram / Facebook

**Post principal (carrossel com as imagens de `img/`):**

```
Seu celular pode ser o caixa da sua loja. De graça. 🛒📱

O PDV Caixa Rápido é um ponto de venda completo que roda no navegador:

✅ Leitor de código de barras pela câmera
✅ Pix com QR Code gerado na hora — sem taxas de intermediário
✅ Controle de estoque com alerta de validade e reposição
✅ Abertura e fechamento de caixa com conferência
✅ Relatórios: faturamento, ticket médio e curva ABC
✅ Funciona offline e instala como aplicativo

Sem mensalidade. Sem cadastro. Sem enrolação.

👉 Link na bio para testar agora (login de demonstração na tela).

#pdv #pontodevenda #mercadinho #comerciolocal #pix #empreendedorismo
#pequenosnegocios #lojista #gestaodeestoque #vendas #tecnologia #appgratis
```

**Bio do Instagram:**

```
🛒 PDV grátis no seu celular
📷 Código de barras + 💰 Pix sem taxa + 📦 Estoque
⬇️ Teste agora (não precisa cadastro)
[LINK]
```

**Stories (sequência de 3):**
1. Foto do caixa/balcão + texto: "Ainda anota venda no caderno? 👀"
2. Print da tela do caixa + texto: "Seu celular vira PDV. De graça. Sem mensalidade."
3. Print do Pix + texto: "QR Code Pix na hora, direto pra sua conta. Arrasta pra cima 👆"

## 6. LinkedIn / comunidades técnicas (dev.to, Reddit r/brdev, Tabnews)

```
Construí um PDV completo que roda 100% no navegador — sem backend, sem build,
sem framework. 🛒

O PDV · Caixa Rápido nasceu de uma constatação: sistema de ponto de venda é
caro demais para o mercadinho de bairro, e o lojista já tem um computador
potente no bolso.

O que tem dentro:
• Leitor de código de barras com BarcodeDetector nativo (fallback html5-qrcode)
• Pix "copia e cola" + QR Code (BR Code EMV) gerados no aparelho, sem taxas
• Controle de estoque, validade e caixa (sangria, reforço, conferência)
• Relatórios com curva ABC e margem de lucro
• PWA offline-first com service worker
• Multiusuário com perfis e permissões
• Modo SaaS opcional: sincronização entre aparelhos via Supabase com RLS
  (isolamento por empresa) — o lojista nem vê tela nova, só faz login

Stack: HTML/CSS/JS puro. Zero dependências de build. Testes unitários em Node
e E2E com Playwright rodando em CI.

Código aberto no GitHub: [LINK-GITHUB]
Demo (gerente/1234): [LINK]

Feedback é muito bem-vindo!
```

## 7. Descrição para diretórios (Product Hunt, catálogos de apps)

**Tagline (60 caracteres):** Ponto de venda grátis e offline no navegador do celular

**Descrição:**

```
PDV · Caixa Rápido transforma qualquer celular em um ponto de venda completo.
A câmera lê o código de barras, o Pix sai com QR Code gerado no próprio
aparelho (sem taxas de intermediário), o estoque baixa a cada venda e a
gerência acompanha faturamento, ticket médio, curva ABC e validade dos
produtos. Funciona offline como PWA, tem perfis de caixa e gerência com
permissões, controle de abertura/fechamento de caixa e backup dos dados.
Opcionalmente, sincroniza vários aparelhos pela nuvem (Supabase). Gratuito e
de código aberto.
```

## 8. Roteiro de vídeo demo (60 segundos)

| Tempo | Cena | Fala/Texto |
|---|---|---|
| 0–5s | Caderno de fiado / calculadora no balcão | "Sua loja ainda vende assim?" |
| 5–12s | Celular abrindo o app, tela de login | "Esse é o Caixa Rápido: um PDV grátis que roda no navegador" |
| 12–22s | Câmera lendo código de barras, item caindo no carrinho | "A câmera lê o código de barras e monta a venda" |
| 22–32s | Tela de pagamento, QR Pix aparecendo | "No Pix, o QR Code sai na hora, direto pra sua conta — sem taxa" |
| 32–42s | Tela da gerência: estoque, alerta de validade | "O estoque baixa sozinho e o app avisa o que está vencendo e o que repor" |
| 42–52s | Indicadores: faturamento, ticket médio, gráfico | "E você vê quanto vendeu, o ticket médio e o que dá mais lucro" |
| 52–60s | URL na tela + celular no bolso | "Sem mensalidade, sem instalar nada, funciona offline. Testa agora: [LINK]" |

Dica: grave na vertical (9:16) segurando um produto de verdade — o momento da
câmera lendo o código é o que mais prende atenção.

## 9. Respostas para objeções comuns (FAQ de divulgação)

- **"É grátis mesmo? Qual a pegadinha?"** — É, e o código é aberto: dá para
  auditar. No modo local não existe servidor, então não há custo por trás.
- **"E se eu perder o celular?"** — A gerência exporta backup em JSON a
  qualquer momento; no modo nuvem os dados ficam sincronizados e dá para
  revogar o aparelho perdido.
- **"Preciso de CNPJ / emitir nota?"** — O app não emite NFC-e; ele cuida da
  operação do caixa e do estoque. Para nota fiscal, siga usando a solução da
  sua contabilidade.
- **"O Pix cai na hora?"** — O QR é um BR Code padrão do Banco Central com a
  sua chave: o dinheiro vai direto para a sua conta, como qualquer Pix.
  A confirmação é feita por você no seu banco (o app não intermedeia).
- **"Funciona no meu celular?"** — Qualquer celular com navegador atualizado
  (Chrome/Safari). Não ocupa espaço: instala como atalho (PWA).
- **"Quantos produtos aguenta?"** — Milhares; os dados ficam no próprio
  aparelho e a busca é instantânea.

## 10. Hashtags e canais sugeridos

**Hashtags:** `#pdv #pontodevenda #caixaregistradora #mercadinho #minimercado
#lanchonete #foodtruck #feirante #comerciolocal #pequenosnegocios #mei
#empreendedorismo #pix #gestaodeestoque #appgratis`

**Onde divulgar primeiro (menor esforço, maior retorno):**
1. Grupos de WhatsApp/Facebook de lojistas, MEIs e "comerciantes da cidade X"
2. Instagram com os prints de `img/` em carrossel + vídeo do roteiro acima
3. Associações comerciais e distribuidores locais (eles falam com dezenas de mercadinhos)
4. Comunidades dev (Tabnews, r/brdev, LinkedIn) com o texto técnico — gera estrela no GitHub e credibilidade
5. Página de apresentação pronta: `divulgacao/index.html` (publique junto com o app e use como link de divulgação)

## 11. Imagens

As capturas de tela reais do app estão em [`img/`](img/) (formato de celular,
prontas para stories/carrossel):

| Arquivo | Conteúdo |
|---|---|
| `01-login.png` | Tela de entrada com perfis |
| `02-caixa-venda.png` | Caixa com carrinho e total |
| `03-pagamento-pix.png` | Pagamento Pix com QR Code |
| `04-gerencia-estoque.png` | Estoque com alerta de validade e margem |
| `05-comprovante.png` | Comprovante de venda |
| `06-indicadores.png` | Painel de indicadores da gerência |
| `07-gerencia-vendas.png` | Histórico de vendas e curva ABC |
