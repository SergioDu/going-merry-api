# going-merry-api

Processa a planilha de importação de postagens do `log`: lê o arquivo, normaliza e
valida cada linha, cota o frete e devolve JSON. O `log` continua dono da tela — ele
renderiza o grid e grava a tabela temporária a partir dessa resposta.

Sem banco, sem cache externo, sem fila. O envio responde assim que a planilha é
lida; a cotação roda em segundo plano e o `log` consulta o resultado por polling. O
resultado fica **em memória** até o `log` buscá-lo (6 h depois de pronto). Um
restart perde o que estava em andamento — o `log` recebe `404` e pede para enviar a
planilha de novo. Pelo mesmo motivo o serviço roda com **uma instância só**.

## Rodando

```bash
pnpm install
cp .env.example .env
pnpm run dev      # http://localhost:3020
pnpm test
```

Com `FREIGHT_API_URL` vazio o serviço responde com **valores simulados**, o que
permite testar o caminho inteiro sem a API de cotação no ar. Toda opção simulada
vem com `(SIMULADA)` na descrição.

## A API

Todas as rotas ficam sob `/api/v2/sheets`, o mesmo padrão `/api/v2/<serviço>` que o
nginx de produção repassa para os outros serviços.

### `POST /api/v2/sheets`

`multipart/form-data`:

| campo | o que é |
|---|---|
| `id` | identificador da planilha — o `log` manda o hash da importação (`[A-Za-z0-9_-]`, até 64) |
| `file` | a planilha `.xls` ou `.xlsx` (layout Padrão, 23 colunas) |
| `originPostalCode` | CEP do remetente |
| `clientId` | id da pessoa/cliente da importação |
| `carrierIds` | ids das transportadoras escolhidas, separados por vírgula |
| `modalities` | JSON: as modalidades do cliente para essas transportadoras, com a precificação (ver abaixo) |

Cada item de `modalities` leva o que vai para a API de cotação
(`carrierId`, `modalityId`, `carrierConfigId`, `costTableId`, `priceTableId`,
`profitMargin`, `finalPriceDiscountPct`, `marginDiscountPct`, `fixedDiscount`,
`finalPriceSurchargePct`, `finalPriceFixedSurcharge`) e o que só o log sabe da
modalidade (`onlogModalityId`, `name`, `logo`, `extraDeliveryDays`, `closesPlp` e
os limites `maxWeightKg`, `maxSideCm`, `maxDimensionsSumCm` — zero não limita).
Opcionais: `quoteCarrierId` (OnlogRed cotada como Correios), `extraCost`,
`extraCostPct` e `cubage` (`{ factor, exemption, exemptionKg }`) da conta Jadlog.
Quem monta é o `fwPlanilhaApi::MontaModalidades` do log.

Responde `200` **assim que a planilha é lida**, antes da cotação:

```json
{ "success": true, "id": "a1b2c3", "status": "processing", "total": 1000 }
```

Erro de requisição (arquivo ausente, arquivo que não é planilha, contexto ou `id`
faltando, planilha acima de 5000 linhas) volta `400` com
`{ "success": false, "message": "..." }`. Um `id` já usado volta `409`. As
mensagens são em português: o `log` mostra ao usuário como vieram.

### `GET /api/v2/sheets/:id`

O status da planilha. Enquanto cota:

```json
{ "success": true, "id": "a1b2c3", "status": "processing", "total": 1000, "carrierIds": [1, 2] }
```

Pronta:

```json
{
  "success": true,
  "id": "a1b2c3",
  "status": "completed",
  "total": 1000,
  "carrierIds": [1, 2],
  "rowsWithErrors": 3,
  "quoteCount": 20,
  "durationMs": 109,
  "rows": [
    {
      "line": 2,
      "recipient": { "name": "MARIA SILVA", "postalCode": "01001-000", "...": "..." },
      "parcel": { "weightKg": 1, "heightCm": 10, "widthCm": 20, "lengthCm": 30, "diameterCm": 0 },
      "goodsValue": 100, "declaredValue": 0,
      "invoiceNumber": "", "invoiceAccessKey": "", "withDeliveryReceipt": false, "senderReference": "",
      "errors": [],
      "options": [ { "carrierId": 1, "modalityId": 10, "modalityName": "SEDEX", "finalPrice": 25.9, "...": "..." } ]
    }
  ]
}
```

As linhas voltam **na ordem da planilha**, cada uma com o número da linha no
arquivo. Uma linha com problema volta com `errors` preenchido e `options` vazio —
ela nunca derruba a planilha inteira.

Falha inesperada na cotação: `"status": "failed"` com `message`. Planilha que o
serviço não conhece (restart, resultado expirado, `id` errado): `404`.

### `GET /api/v2/sheets/health`

`{ "status": "ok" }`.

### Autenticação

Se `API_TOKEN` estiver setado, toda requisição precisa de `Authorization: Bearer <token>`.
Vazio deixa o serviço aberto — o que é o esperado num deploy em rede privada.

## Por que mil linhas cabem

Numa planilha real, mil linhas são poucos pacotes diferentes indo para poucas
cidades. As linhas que fariam a mesma pergunta são perguntadas **uma vez só**: o
mapa de deduplicação vive dentro da requisição e morre com ela, então preço nenhum
envelhece entre uma importação e outra. As cotações distintas saem em paralelo, com
teto fixo (`FREIGHT_CONCURRENCY`).

O campo `quoteCount` da resposta diz quantas cotações realmente saíram. Numa
planilha de teste de 1000 linhas, 20.

## O endpoint de frete

A cotação é da `cotacao-api-v2`: `POST {FREIGHT_API_URL}` (a rota
`/api/v2/cotacao/valores/v2`), com a chave em `X-Api-Key` (`FREIGHT_API_KEY`). Uma
chamada por pacote distinto da planilha, com todas as modalidades do cliente que
cabem naquele pacote. O body e a resposta mantêm os nomes em português da
`cotacao-api-v2` — o contrato é dela.

Tudo que sabe falar com ela está em [`src/freight/httpQuoter.ts`](src/freight/httpQuoter.ts) —
`toRequestBody` (o que mandamos) e `toOption` (o que lemos de volta), com as
fixtures em `test/freight/httpQuoter.test.ts`.

Por cima dele, [`src/freight/perAccountQuoter.ts`](src/freight/perAccountQuoter.ts)
aplica o que a v1 da Jadlog faz por conta e a v2 não: cota cada modalidade no peso
cubado da conta (uma chamada por peso distinto), soma o adicional de custo da conta
antes da margem e, quando a modalidade vem em mais de uma conta, fica com a mais
barata.

## Layout

```
src/sheet/text.ts              # formatação portada do fwBase do log (acentos, CEP, CPF/CNPJ, telefone)
src/sheet/row.ts               # as 23 colunas do layout Padrão -> linha normalizada + erros da linha
src/sheet/reader.ts            # arquivo .xls/.xlsx -> linhas brutas (SheetJS)
src/sheet/jobs.ts              # planilhas em cotação e resultados à espera do log (memória, com validade)
src/freight/freight.ts         # o contrato de frete (porta Quoter, QuoteRequest, FreightOption)
src/freight/httpQuoter.ts      # o adaptador do endpoint de frete — o ponto de troca
src/freight/perAccountQuoter.ts # cubagem, adicional de custo e melhor conta (paridade com a jadlog/v1)
src/freight/simulatedQuoter.ts # valores falsos enquanto o endpoint não existe
src/freight/quoteRows.ts       # deduplicação + concorrência sobre a planilha inteira
src/http/                      # Fastify + POST /api/v2/sheets + GET /api/v2/sheets/:id
src/main.ts                    # boot e shutdown
```
