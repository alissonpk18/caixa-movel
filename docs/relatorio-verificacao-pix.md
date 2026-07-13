# Relatório de verificação — Geração do Pix (BR Code / QR)

**Data:** 13/07/2026 · **Escopo:** geração do payload Pix "copia e cola" e do QR Code na finalização da venda.

## Veredito

✅ **A geração do Pix está funcionando corretamente.** Foram executadas três camadas de verificação — testes unitários do projeto, testes e2e no navegador real e uma bateria independente de 31 checagens escritas para esta auditoria — e **todas passaram (0 falhas)**. O payload gerado segue o padrão EMV-MPM exigido pelo Manual de Iniciação do Pix (BCB), o CRC-16 confere com implementação independente e com o vetor oficial do BCB, e o QR renderizado decodifica de volta para exatamente o mesmo payload.

## O que foi verificado

### 1. Testes automatizados do projeto

| Suíte | Resultado |
|---|---|
| Unitários (`npm test`, Node) | **30/30 PASS** |
| E2E (`tests/e2e/features.e2e.mjs`, Chromium + Playwright) | **30/30 PASS** |

Os e2e exercitam o fluxo real no navegador: configurar a chave na gerência, persistir, abrir uma venda, escolher Pix, verificar que o payload começa com `000201` e contém o valor (`540510.00`), que o **SVG do QR é renderizado**, que o **CRC confere**, que o **copia e cola vai para a área de transferência** e que a venda é registrada com `payment.method === "pix"` — tudo sem erros de JS no console.

### 2. Auditoria independente (31 checagens, todas PASS)

Script escrito do zero para esta verificação (não reutiliza asserções do projeto): parser TLV próprio, CRC-16 de referência com tabela de bytes e decodificação do QR com a biblioteca `jsQR`.

**Conformidade estrutural (EMV-MPM / BCB):**
- TLV parseia sem erro; tags em ordem crescente; payload 100% ASCII visível.
- Tag `00` = `01` (formato), `26-00` = `br.gov.bcb.pix` (GUI), `26-01` = chave, `52` = `0000` (MCC), `53` = `986` (BRL), `58` = `BR`, `62-05` = txid, `63` (CRC) é a última tag com 4 caracteres.
- Nome (tag 59) e cidade (tag 60) saem sem acentos e dentro dos limites de 25/15 caracteres.
- `crc16()` do projeto reproduz o exemplo oficial do manual do BCB (payload de referência → `1D3D`) e confere com a implementação independente em todos os payloads testados.

**Casos-limite:**
- Chave EVP (UUID de 36 chars) e chave no limite de 77 chars geram payload válido; 78 chars é rejeitada (`null`).
- Valores: `0.1` → `0.10`; `0.1+0.2` → `0.30` (sem lixo de ponto flutuante, graças ao `round2`); teto do app `999999.99` ok; valor `0` ou negativo omite a tag 54 (vira QR sem valor, comportamento correto).
- Txid com caracteres inválidos (`pedido #42 çã`) é saneado para `pedido42`.
- Nome que fica vazio após remover acentos/emoji → payload rejeitado (`null`), em vez de gerar BR Code quebrado.
- Cidade vazia usa o fallback `BRASIL`; espaços nas pontas de chave/nome são aparados.

**Round-trip do QR:** o QR foi gerado com a mesma `qrcode.min.js` usada pelo app (correção automática nível M), rasterizado e **decodificado de volta com jsQR — o texto decodificado é byte a byte igual ao payload**. Ou seja, o que o cliente escaneia é exatamente o BR Code gerado.

### 3. Revisão do código

- `pdv-core.js:143-171` — `pixPayload()` é pura e testável; valida chave (obrigatória, ≤77) e nome (obrigatório após saneamento) antes de montar o TLV; monta o CRC por último sobre o corpo + `6304`, como manda a especificação.
- `js/sale.js:130-151` — na finalização, se a config estiver ausente/inválida o operador vê mensagem clara em vez de um QR quebrado; se a lib de QR falhar, o **copia e cola continua disponível** (degradação graciosa).
- `js/sale.js:169-188` — o salvamento da config na gerência valida com `pixPayload()` de verdade (dry-run com valor 1) antes de persistir, então config inválida nem chega a ser salva.
- `pdv-core.js:60-62` — `sanitizeSettings` reforça os limites (chave ≤77, nome ≤25, cidade ≤15) em tudo que vem do storage, protegendo contra dados antigos/corrompidos.

## Observação (não é defeito, apenas endurecimento possível)

A **chave** Pix não passa pelo saneamento ASCII (`pixText`) — apenas nome e cidade passam. Se a gerência digitar uma chave com acento (ex.: `chavé@x.com`), o payload é gerado com o caractere não-ASCII e o tamanho declarado no TLV divergiria dos bytes UTF-8 no QR; o app do banco rejeitaria a leitura. Na prática toda chave Pix real (e-mail, telefone, CPF/CNPJ, EVP) é ASCII, então isso só ocorre se a chave digitada já for inválida — mas rejeitar chaves com caracteres fora de `\x20-\x7E` em `pixPayload`/`savePixConfig` daria uma mensagem de erro imediata em vez de um QR que o banco recusa.

## Como reproduzir

```bash
npm test                                          # unitários (30)
python3 -m http.server 8899 &                     # servir o app
npm i --no-save playwright                        # runner e2e
CHROMIUM_PATH=<chromium> node tests/e2e/features.e2e.mjs
```
