# planilha-api

Processa a planilha de importação de postagens do `log`. Recebe o arquivo e responde
`200` assim que ele é lido; a cotação roda em segundo plano e o `log` faz polling em
`GET /api/v1/planilha/:id` até ela terminar, recebendo uma linha normalizada,
validada e cotada por linha da planilha. O `log` continua dono do HTML do grid e da
gravação em `tbCorePostagemImportacaoTemp` — este serviço não tem banco.

## Stack

- **Node.js 24** (base `node:24-alpine`), **TypeScript**.
- **Fastify** + **@fastify/multipart** (upload), **SheetJS/xlsx** (lê `.xls` e
  `.xlsx`), **axios** (endpoint de frete).
- **Vitest**, escrito **test-first (TDD)**.

## Convenções

- **pnpm** para tudo (`pnpm install`, `pnpm run dev`, `pnpm add <pkg>`).
- **TDD.** Escreve o teste, vê falhar, implementa. `pnpm test`. Os testes não
  tocam rede: o cotador é injetado. Testam intenção — comportamento observável e
  contrato, não mecânica interna.
- **Simples de propósito.** Sem fila, sem Redis, sem banco, sem abstração que não
  esteja pagando por si. A deduplicação de cotações é um `Map` dentro da
  requisição; a concorrência é um pool de ~15 linhas. O resultado à espera do log
  é um `Map` com validade (`src/planilha/processamentos.ts`) — por isso o serviço
  roda com **uma instância só**, e um restart vira `404` no polling (o log pede
  para reenviar a planilha).
- **Logging.** JSON estruturado no stdout (Alloy → Loki → Grafana), prefixo
  `[planilha]`.

## Paridade com o log — a regra que importa

`src/planilha/texto.ts` é uma **porta dos helpers do `fwBase`** do log
(`substituiAcentos`, `SeparaEndereco`, `FormataCEPOnlog`, `FormataCpfCnpj`,
`FormataTelefone`) e do `fwValidaCPFCNPJ`. As mensagens de erro de
`src/planilha/linha.ts` são as mesmas do
`vwValidacaoPostagem::validaPostagemImportacaoTempPreCalculoFrete`.

As linhas que saem daqui vão para a mesma tabela temporária que o log preenche
sozinho no fluxo antigo. **Uma divergência aqui vira duas postagens diferentes para
a mesma planilha.** Mexeu num desses helpers no log, mexe aqui também.

Fica aqui só o que a linha responde sozinha. O que depende do cadastro do cliente
ou de serviço externo — dados do remetente, consulta de CEP nos Correios, inscrição
estadual, teto de valor declarado por modalidade — continua no log, que já tem esse
contexto.

## O endpoint de frete é de outro projeto

É a `POST /api/v2/cotacao/valores/v2` da `cotacao-api-v2` (`FRETE_API_URL`, chave
em `X-Api-Key` via `FRETE_API_KEY`). Tudo que sabe falar com ela está em
`src/frete/cotadorHttp.ts`, atrás da porta `Cotador`.

A precificação é do cliente, e o serviço não tem banco: o log manda as modalidades
já resolvidas (tabelas, margem, descontos, config de operador) no campo
`modalidades` do upload. Aqui só se filtra cada modalidade pelos limites do pacote
(`src/frete/modalidades.ts`, mesma regra do `ValidaLimitesModalidade` do log) e se
traduz a resposta de volta para o id de modalidade do log (`idModalidadeOnlog`).

Com `FRETE_API_URL` vazia o serviço usa `CotadorSimulado` — valores falsos,
marcados como tal em toda opção, para exercitar o caminho inteiro. Nunca em produção.

## Escopo atual

Só o **layout Padrão** (layout 1, 23 colunas do `Modelo - Padrao.xls`). Múltiplos
Remetentes (layout 2) e XML NFe (layout 4) seguem pelo fluxo antigo do log.
