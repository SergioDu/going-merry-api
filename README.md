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

Com `FRETE_API_URL` vazio o serviço responde com **valores simulados**, o que
permite testar o caminho inteiro sem a API de cotação no ar. Toda opção simulada
vem com `(SIMULADA)` na descrição.

## A API

### `POST /api/v1/planilha/processar`

`multipart/form-data`:

| campo | o que é |
|---|---|
| `id` | identificador da planilha — o `log` manda o hash da importação (`[A-Za-z0-9_-]`, até 64) |
| `arquivo` | a planilha `.xls` ou `.xlsx` (layout Padrão, 23 colunas) |
| `cepOrigem` | CEP do remetente |
| `idCliente` | id da pessoa/cliente da importação |
| `operadores` | ids das transportadoras escolhidas, separados por vírgula |
| `modalidades` | JSON: as modalidades do cliente para essas transportadoras, com a precificação (ver abaixo) |

Cada item de `modalidades` leva o que vai para a API de cotação
(`idOperador`, `idModalidade`, `idCoreOperadorConfig`, `idTabelaCusto`,
`idTabelaVenda`, `margemLucro`, `descPercVlFinal`, `descPercMargem`,
`descValorFixo`, `adicionalPercVlFinal`, `adicionalValorFixoVlFinal`) e o que só o
log sabe da modalidade (`idModalidadeOnlog`, `descricao`, `logo`,
`prazoAdicional`, `fechaPlp` e os limites `pesoMaximo`, `medidaMaximaPorLado`,
`medidaMaxima` — zero não limita). Quem monta é o
`fwPlanilhaApi::MontaModalidades` do log.

Responde `200` **assim que a planilha é lida**, antes da cotação:

```json
{ "sucesso": true, "id": "a1b2c3", "status": "processando", "total": 1000 }
```

Erro de requisição (arquivo ausente, arquivo que não é planilha, contexto ou `id`
faltando, planilha acima de 5000 linhas) volta `400` com
`{ "sucesso": false, "mensagem": "..." }`. Um `id` já usado volta `409`.

### `GET /api/v1/planilha/:id`

O status da planilha. Enquanto cota:

```json
{ "sucesso": true, "id": "a1b2c3", "status": "processando", "total": 1000, "operadores": [1, 2] }
```

Pronta:

```json
{
  "sucesso": true,
  "id": "a1b2c3",
  "status": "concluida",
  "total": 1000,
  "operadores": [1, 2],
  "comErro": 3,
  "cotacoes": 20,
  "tempoMs": 109,
  "linhas": [
    {
      "linha": 2,
      "destinatario": { "nome": "MARIA SILVA", "cep": "01001-000", "...": "..." },
      "objeto": { "pesoKg": 1, "alturaCm": 10, "larguraCm": 20, "comprimentoCm": 30, "diametroCm": 0 },
      "valorMercadoria": 100, "valorDeclarado": 0,
      "numeroNf": "", "chaveAcessoNf": "", "comAr": false, "controleRemetente": "",
      "erros": [],
      "opcoes": [ { "idOperador": 1, "idModalidade": 10, "descricaoModalidade": "SEDEX", "valorFinal": 25.9, "...": "..." } ]
    }
  ]
}
```

As linhas voltam **na ordem da planilha**, cada uma com o número da linha no
arquivo. Uma linha com problema volta com `erros` preenchido e `opcoes` vazio — ela
nunca derruba a planilha inteira.

Falha inesperada na cotação: `"status": "erro"` com `mensagem`. Planilha que o
serviço não conhece (restart, resultado expirado, `id` errado): `404`.

### `GET /api/v1/saude`

`{ "status": "ok" }`.

### Autenticação

Se `API_TOKEN` estiver setado, toda requisição precisa de `Authorization: Bearer <token>`.
Vazio deixa o serviço aberto — o que é o esperado num deploy em rede privada.

## Por que mil linhas cabem

Numa planilha real, mil linhas são poucos pacotes diferentes indo para poucas
cidades. As linhas que fariam a mesma pergunta são perguntadas **uma vez só**: o
mapa de deduplicação vive dentro da requisição e morre com ela, então preço nenhum
envelhece entre uma importação e outra. As cotações distintas saem em paralelo, com
teto fixo (`FRETE_CONCORRENCIA`).

O campo `cotacoes` da resposta diz quantas cotações realmente saíram. Numa planilha
de teste de 1000 linhas, 20.

## O endpoint de frete

A cotação é da `cotacao-api-v2`: `POST {FRETE_API_URL}` (a rota
`/api/v2/cotacao/valores/v2`), com a chave em `X-Api-Key` (`FRETE_API_KEY`). Uma
chamada por pacote distinto da planilha, com todas as modalidades do cliente que
cabem naquele pacote.

Tudo que sabe falar com ela está em [`src/frete/cotadorHttp.ts`](src/frete/cotadorHttp.ts) —
`paraRequisicao` (o que mandamos) e `paraOpcao` (o que lemos de volta), com as
fixtures em `test/frete/cotadorHttp.test.ts`.

Por cima dele, [`src/frete/cotadorPorConta.ts`](src/frete/cotadorPorConta.ts) aplica o
que a v1 da Jadlog faz por conta e a v2 não: cota cada modalidade no peso cubado
da conta (uma chamada por peso distinto), soma o adicional de custo da conta antes
da margem e, quando a modalidade vem em mais de uma conta, fica com a mais barata.

## Layout

```
src/planilha/texto.ts        # formatação portada do fwBase do log (acentos, CEP, CPF/CNPJ, telefone)
src/planilha/linha.ts        # as 23 colunas do layout Padrão -> linha normalizada + erros da linha
src/planilha/leitor.ts       # arquivo .xls/.xlsx -> linhas brutas (SheetJS)
src/frete/frete.ts           # o contrato de frete (porta Cotador, PedidoCotacao, OpcaoFrete)
src/frete/cotadorHttp.ts     # o adaptador do endpoint de frete — o ponto de troca
src/frete/cotadorPorConta.ts # cubagem, adicional de custo e melhor conta (paridade com a jadlog/v1)
src/frete/cotadorSimulado.ts # valores falsos enquanto o endpoint não existe
src/frete/cotarLinhas.ts     # deduplicação + concorrência sobre a planilha inteira
src/planilha/processamentos.ts # planilhas em cotação e resultados à espera do log (memória, com validade)
src/http/                    # Fastify + POST /api/v1/planilha/processar + GET /api/v1/planilha/:id
src/main.ts                  # boot e shutdown
```
