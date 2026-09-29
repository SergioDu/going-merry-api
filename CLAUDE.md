# going-merry-api

Processa a planilha de importação de postagens do `log`. Recebe o arquivo e responde
`200` assim que ele é lido; a cotação roda em segundo plano e o `log` faz polling em
`GET /api/v2/sheets/:id` até ela terminar, recebendo uma linha normalizada,
validada e cotada por linha da planilha. O `log` continua dono do HTML do grid e da
gravação em `tbCorePostagemImportacaoTemp` — este serviço não tem banco.

## Stack

- **Node.js 24** (base `node:24-alpine`), **TypeScript**.
- **Fastify** + **@fastify/multipart** (upload), **SheetJS/xlsx** (lê `.xls` e
  `.xlsx`), **axios** (endpoint de frete).
- **Vitest**, escrito **test-first (TDD)**.

## Convenções

- **Código em inglês.** Pastas, arquivos, tipos, funções, variáveis, variáveis de
  ambiente e o contrato HTTP com o `log` (rotas, campos, status) são em inglês.
  Ficam em português só as mensagens de log, as mensagens que o `log` mostra ao
  usuário (erros de linha, `message` das respostas, "ENTREGA EM N DIAS ÚTEIS") e o
  body/resposta da `cotacao-api-v2`, que é contrato do outro projeto.
- **Rotas sob `/api/v2/sheets`.** O nginx de produção repassa `/api/v2/<serviço>`
  como está, então o serviço é dono do caminho inteiro.
- **pnpm** para tudo (`pnpm install`, `pnpm run dev`, `pnpm add <pkg>`).
- **TDD.** Escreve o teste, vê falhar, implementa. `pnpm test`. Os testes não
  tocam rede: o cotador é injetado. Testam intenção — comportamento observável e
  contrato, não mecânica interna.
- **Simples de propósito.** Sem fila, sem Redis, sem banco, sem abstração que não
  esteja pagando por si. A deduplicação de cotações é um `Map` dentro da
  requisição; a concorrência é um pool de ~15 linhas. O resultado à espera do log
  é um `Map` com validade (`src/sheet/jobs.ts`) — por isso o serviço
  roda com **uma instância só**, e um restart vira `404` no polling (o log pede
  para reenviar a planilha).
- **Logging.** JSON estruturado no stdout (Alloy → Loki → Grafana), prefixo
  `[planilha]`.

## Paridade com o log — a regra que importa

`src/sheet/text.ts` é uma **porta dos helpers do `fwBase`** do log
(`substituiAcentos`, `SeparaEndereco`, `FormataCEPOnlog`, `FormataCpfCnpj`,
`FormataTelefone`) e do `fwValidaCPFCNPJ`. As mensagens de erro de
`src/sheet/row.ts` são as mesmas do
`vwValidacaoPostagem::validaPostagemImportacaoTempPreCalculoFrete`.

As linhas que saem daqui vão para a mesma tabela temporária que o log preenche
sozinho no fluxo antigo. **Uma divergência aqui vira duas postagens diferentes para
a mesma planilha.** Mexeu num desses helpers no log, mexe aqui também.

Fica aqui só o que a linha responde sozinha. O que depende do cadastro do cliente
ou de serviço externo — dados do remetente, consulta de CEP nos Correios, inscrição
estadual, teto de valor declarado por modalidade — continua no log, que já tem esse
contexto.

## O endpoint de frete é de outro projeto

É a `POST /api/v2/cotacao/valores/v2` da `cotacao-api-v2` (`FREIGHT_API_URL`, chave
em `X-Api-Key` via `FREIGHT_API_KEY`). Tudo que sabe falar com ela está em
`src/freight/httpQuoter.ts`, atrás da porta `Quoter`.

A precificação é do cliente, e o serviço não tem banco: o log manda as modalidades
já resolvidas (tabelas, margem, descontos, config de operador) no campo
`modalities` do upload. Aqui só se filtra cada modalidade pelos limites do pacote
(`src/freight/modalities.ts`, mesma regra do `ValidaLimitesModalidade` do log) e se
traduz a resposta de volta para o id de modalidade do log (`onlogModalityId`).

**Paridade com a v1 da Jadlog.** Produção ainda cota a Jadlog pela `jadlog/v1`
(Node, `cotacaoapi/src/regra/rnCotacao.js`), que faz por conta o que a v2 não faz:
cubagem pelos parâmetros da conta, `AdicionalCusto` somado ao custo antes da
margem e escolha da conta mais barata na melhor conta. O log manda uma entrada por
conta com esses parâmetros, e `src/freight/perAccountQuoter.ts` aplica as três regras
em volta do `HttpQuoter`, sem mexer na API de cotação. A OnlogRed vai como
operador 13 (`quoteCarrierId`), porque a v2 só roteia as tabelas dela como
Correios, e volta como 132226.

A resposta da v2 não tem caixa confiável: fresca vem em camelCase, do cache dela em
PascalCase. O `httpQuoter.ts` lê os campos sem diferenciar maiúsculas.

Com `FREIGHT_API_URL` vazia o serviço usa `SimulatedQuoter` — valores falsos,
marcados como tal em toda opção, para exercitar o caminho inteiro. Nunca em produção.

## Escopo atual

Só o **layout Padrão** (layout 1, 23 colunas do `Modelo - Padrao.xls`). Múltiplos
Remetentes (layout 2) e XML NFe (layout 4) seguem pelo fluxo antigo do log.
