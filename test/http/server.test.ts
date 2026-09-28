import { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

import { Cotador, OpcaoFrete } from "../../src/frete/frete";
import { buildServer } from "../../src/http/server";
import { ServerDeps } from "../../src/http/types";
import { Processamentos } from "../../src/planilha/processamentos";

const CABECALHO = [
  "DESTINATARIO_NOME",
  "DESTINATARIO_LOGRADOURO",
  "DESTINATARIO_NUMERO",
  "DESTINATARIO_COMPL",
  "DESTINATARIO_BAIRRO",
  "DESTINATARIO_CIDADE",
  "DESTINATARIO_UF",
  "DESTINATARIO_CEP",
  "DESTINATARIO_CPFCNPJ",
  "DESTINATARIO_RGIE",
  "DESTINATARIO_TELEFONE",
  "DESTINATARIO_EMAIL",
  "OBJETO_PESO_KG",
  "OBJETO_ALTURA_CM",
  "OBJETO_LARGURA_CM",
  "OBJETO_COMPRIMENTO_CM",
  "OBJETO_DIAMETRO_CM",
  "VALOR_MERCADORIA",
  "VALOR_DECLARADO",
  "NUMERO_NF",
  "CHAVEACESSO_NF",
  "COM_AR",
  "CONTROLE_REMETENTE",
];

// A valid row of the standard template; `sobrescreve` breaks one cell at a time.
function linhaValida(sobrescreve: Record<number, unknown> = {}): unknown[] {
  const linha: unknown[] = [
    "MARIA SILVA",
    "RUA DAS FLORES",
    "10",
    "",
    "CENTRO",
    "SAO PAULO",
    "SP",
    "01001-000",
    "529.982.247-25",
    "",
    "11999998888",
    "",
    1,
    10,
    20,
    30,
    0,
    100,
    0,
    "",
    "",
    "",
    "",
  ];

  for (const [indice, valor] of Object.entries(sobrescreve)) linha[Number(indice)] = valor;

  return linha;
}

function planilha(linhas: unknown[][]): Buffer {
  const livro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([CABECALHO, ...linhas]), "Planilha1");

  return XLSX.write(livro, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const LIMITE = "----------------------------planilhaapi";

// Builds the multipart body the log posts: the spreadsheet plus the context
// fields that are the same for the whole sheet. `arquivoPrimeiro` puts the file
// ahead of the fields, which is the order PHP's curl sends by default.
function corpoMultipart(
  campos: Record<string, string>,
  arquivo?: { nome: string; conteudo: Buffer },
  arquivoPrimeiro = false,
): Buffer {
  const partesCampos = Object.entries(campos).map(([nome, valor]) =>
    Buffer.from(`--${LIMITE}\r\nContent-Disposition: form-data; name="${nome}"\r\n\r\n${valor}\r\n`),
  );

  const partesArquivo = arquivo
    ? [
        Buffer.from(
          `--${LIMITE}\r\nContent-Disposition: form-data; name="arquivo"; filename="${arquivo.nome}"\r\n` +
            `Content-Type: application/vnd.ms-excel\r\n\r\n`,
        ),
        arquivo.conteudo,
        Buffer.from("\r\n"),
      ]
    : [];

  const partes = arquivoPrimeiro ? [...partesArquivo, ...partesCampos] : [...partesCampos, ...partesArquivo];

  return Buffer.concat([...partes, Buffer.from(`--${LIMITE}--\r\n`)]);
}

// The client's modalities, as the log sends them: one JSON field of the multipart.
const MODALIDADES = JSON.stringify([
  { idOperador: 13, idModalidade: 3, idTabelaCusto: 1, idTabelaVenda: 2, idModalidadeOnlog: 301, descricao: "SEDEX" },
]);

function opcao(sobrescreve: Partial<OpcaoFrete> = {}): OpcaoFrete {
  return {
    idOperador: 1,
    idModalidade: 10,
    idOperadorConfig: null,
    descricaoModalidade: "SEDEX",
    logoOperador: "",
    prazo: 3,
    prazoDias: "3 dias úteis",
    valorFinal: 25.9,
    valorFinalCheio: 25.9,
    valorOriginal: 18,
    valorCustoSemAdic: 18,
    valorVendaSemAdic: 25.9,
    valorSeguroContrato: 0,
    valorSeguroVenda: 0,
    valorArContrato: 0,
    valorArVenda: 0,
    fechaPlp: 1,
    informacaoAdicional: "",
    ...sobrescreve,
  };
}

function buildDeps(overrides: Partial<ServerDeps> = {}) {
  const cotar = vi.fn<Cotador["cotar"]>().mockResolvedValue([opcao()]);

  const deps: ServerDeps = {
    cotador: { cotar },
    concorrencia: 20,
    processamentos: new Processamentos(),
    ...overrides,
  };

  return { deps, cotar };
}

// The log names each sheet it sends (its import hash); every test sheet gets its own.
let ultimoId = 0;
function novoId(): string {
  ultimoId++;
  return `planilha-${ultimoId}`;
}

// Posts a sheet the way the log does. Answers as soon as the sheet is read — the
// quoting goes on in the background.
function enviar(
  app: FastifyInstance,
  linhas: unknown[][],
  campos: Record<string, string> = {},
  cabecalhos: Record<string, string> = {},
) {
  const corpo = corpoMultipart(
    { id: novoId(), cepOrigem: "04571-010", idCliente: "99", operadores: "1,2", modalidades: MODALIDADES, ...campos },
    { nome: "planilha.xlsx", conteudo: planilha(linhas) },
  );

  return app.inject({
    method: "POST",
    url: "/api/v1/planilha/processar",
    payload: corpo,
    headers: { "content-type": `multipart/form-data; boundary=${LIMITE}`, ...cabecalhos },
  });
}

// What the log's polling reads.
function consultar(app: FastifyInstance, id: string, cabecalhos: Record<string, string> = {}) {
  return app.inject({ method: "GET", url: `/api/v1/planilha/${id}`, headers: cabecalhos });
}

// Polls until the sheet is no longer being processed, like the log does.
async function aguardarResultado(app: FastifyInstance, id: string) {
  for (let tentativa = 0; tentativa < 100; tentativa++) {
    const res = await consultar(app, id);
    if (res.json().status !== "processando") return res;
    await new Promise((resolve) => setImmediate(resolve));
  }

  throw new Error(`a planilha ${id} não terminou de processar`);
}

// Sends a sheet and waits for its result.
async function processar(deps: ServerDeps, linhas: unknown[][], campos: Record<string, string> = {}) {
  const app = buildServer({ deps });

  const envio = await enviar(app, linhas, campos);
  expect(envio.statusCode).toBe(200);

  const res = await aguardarResultado(app, envio.json().id);
  await app.close();

  return res;
}

describe("POST /api/v1/planilha/processar", () => {
  it("answers 200 right away, before the sheet is quoted", async () => {
    let liberar: () => void = () => {};
    const segura = new Promise<void>((resolve) => {
      liberar = resolve;
    });
    const cotar = vi.fn<Cotador["cotar"]>().mockImplementation(async () => {
      await segura;
      return [opcao()];
    });
    const { deps } = buildDeps({ cotador: { cotar } });
    const app = buildServer({ deps });

    const envio = await enviar(app, [linhaValida(), linhaValida({ 0: "JOAO SOUZA" })], { id: "hash-1" });

    expect(envio.statusCode).toBe(200);
    expect(envio.json()).toEqual({ sucesso: true, id: "hash-1", status: "processando", total: 2 });
    expect((await consultar(app, "hash-1")).json()).toMatchObject({ status: "processando", total: 2 });

    liberar();
    const res = await aguardarResultado(app, "hash-1");

    expect(res.json()).toMatchObject({ sucesso: true, id: "hash-1", status: "concluida", total: 2 });
    await app.close();
  });

  it("parses, validates and quotes every row of the sheet", async () => {
    const { deps, cotar } = buildDeps();

    const res = await processar(deps, [linhaValida(), linhaValida({ 0: "JOAO SOUZA" })]);

    expect(res.statusCode).toBe(200);
    const corpo = res.json();
    expect(corpo.total).toBe(2);
    expect(corpo.linhas).toHaveLength(2);
    expect(corpo.linhas[0].destinatario.nome).toBe("MARIA SILVA");
    expect(corpo.linhas[0].opcoes[0].descricaoModalidade).toBe("SEDEX");
    expect(cotar).toHaveBeenCalled();
  });

  it("forwards the sheet's context into the quote", async () => {
    const { deps, cotar } = buildDeps();

    await processar(deps, [linhaValida()], { cepOrigem: "04571-010" });

    const pedido = cotar.mock.calls[0][0];
    expect(pedido.cepOrigem).toBe("04571-010");
    expect(pedido.modalidades.map((m) => [m.idOperador, m.idModalidade, m.idModalidadeOnlog])).toEqual([[13, 3, 301]]);
  });

  // What ties a logged quote back to the import the user is looking at.
  it("tags each quote with the sheet's id and the rows it prices", async () => {
    const { deps, cotar } = buildDeps();

    await processar(deps, [linhaValida()], { id: "abc123" });

    expect(cotar.mock.calls[0][1]).toEqual({ idPlanilha: "abc123", linhas: [2] });
  });

  // The log writes the temp rows when it finds the sheet finished, in a later
  // request than the upload: it gets back the operators it sent, not a copy of
  // its own.
  it("hands the sheet's operators back with the result", async () => {
    const { deps } = buildDeps();

    const res = await processar(deps, [linhaValida()], { operadores: "3,4" });

    expect(res.json().operadores).toEqual([3, 4]);
  });

  it("keeps the rows in the sheet's order, with their line numbers", async () => {
    const { deps } = buildDeps();

    const res = await processar(deps, [linhaValida(), linhaValida({ 0: "B" }), linhaValida({ 0: "C" })]);

    expect(res.json().linhas.map((l: { linha: number }) => l.linha)).toEqual([2, 3, 4]);
  });

  it("returns a bad row with its errors instead of failing the whole sheet", async () => {
    const { deps } = buildDeps();

    const res = await processar(deps, [linhaValida({ 7: "" }), linhaValida()]);

    const corpo = res.json();
    expect(corpo.total).toBe(2);
    expect(corpo.comErro).toBe(1);
    expect(corpo.linhas[0].erros).toContain("CEP do destinatário não pode ser vazio");
    expect(corpo.linhas[0].opcoes).toEqual([]);
    expect(corpo.linhas[1].erros).toEqual([]);
  });

  it("reports how long the sheet took, so a slow import is visible", async () => {
    const { deps } = buildDeps();

    const res = await processar(deps, [linhaValida()]);

    expect(typeof res.json().tempoMs).toBe("number");
  });

  // PHP's curl sends the file part before the text fields. The context has to be
  // read whatever order the parts arrive in, or the log's own request is rejected
  // for a CEP it did send. The sheet here is deliberately big enough to arrive in
  // more than one chunk — a small one parses in a single pass and hides the bug.
  it("reads the context even when the file part comes first", async () => {
    const { deps, cotar } = buildDeps();
    const app = buildServer({ deps });

    const grande = planilha(Array.from({ length: 500 }, (_, i) => linhaValida({ 0: `DESTINATARIO ${i}` })));
    expect(grande.length).toBeGreaterThan(64 * 1024);

    const envio = await app.inject({
      method: "POST",
      url: "/api/v1/planilha/processar",
      payload: corpoMultipart(
        { id: "arquivo-primeiro", cepOrigem: "04571-010", idCliente: "99", operadores: "1,2", modalidades: MODALIDADES },
        { nome: "planilha.xlsx", conteudo: grande },
        true,
      ),
      headers: { "content-type": `multipart/form-data; boundary=${LIMITE}` },
    });

    expect(envio.statusCode).toBe(200);
    expect(envio.json().total).toBe(500);

    await aguardarResultado(app, "arquivo-primeiro");
    expect(cotar.mock.calls[0][0]).toMatchObject({ cepOrigem: "04571-010", modalidades: [{ idModalidadeOnlog: 301 }] });
    await app.close();
  });

  it("reports how many quotes the sheet really cost", async () => {
    const { deps, cotar } = buildDeps();

    // Three rows, two of them identical: two quotes.
    const res = await processar(deps, [linhaValida(), linhaValida({ 0: "OUTRO NOME" }), linhaValida({ 12: 9 })]);

    expect(res.json().cotacoes).toBe(2);
    expect(cotar).toHaveBeenCalledTimes(2);
  });

  it("rejects a request with no file", async () => {
    const { deps } = buildDeps();
    const app = buildServer({ deps });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/planilha/processar",
      payload: corpoMultipart({ id: novoId(), cepOrigem: "04571-010", idCliente: "99", operadores: "1", modalidades: MODALIDADES }),
      headers: { "content-type": `multipart/form-data; boundary=${LIMITE}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().mensagem).toMatch(/arquivo/i);
    await app.close();
  });

  it("rejects a file that is not a spreadsheet with the reason", async () => {
    const { deps } = buildDeps();
    const app = buildServer({ deps });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/planilha/processar",
      payload: corpoMultipart(
        { id: novoId(), cepOrigem: "04571-010", idCliente: "99", operadores: "1", modalidades: MODALIDADES },
        { nome: "foto.png", conteudo: Buffer.from("nao sou planilha") },
      ),
      headers: { "content-type": `multipart/form-data; boundary=${LIMITE}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().mensagem).toMatch(/planilha/i);
    await app.close();
  });

  it("rejects a request missing the sheet's context", async () => {
    const { deps } = buildDeps();
    const app = buildServer({ deps });

    expect((await enviar(app, [linhaValida()], { cepOrigem: "" })).statusCode).toBe(400);
    expect((await enviar(app, [linhaValida()], { idCliente: "" })).statusCode).toBe(400);
    expect((await enviar(app, [linhaValida()], { operadores: "" })).statusCode).toBe(400);
    await app.close();
  });

  // Without the client's modalities there is nothing to quote with: the log has
  // to say which ones the client can use and at what price.
  it("rejects a request with no modality, or with modalities that are not a JSON list", async () => {
    const { deps } = buildDeps();
    const app = buildServer({ deps });

    const semModalidade = await enviar(app, [linhaValida()], { modalidades: "[]" });
    expect(semModalidade.statusCode).toBe(400);
    expect(semModalidade.json().mensagem).toMatch(/modalidade/i);

    expect((await enviar(app, [linhaValida()], { modalidades: "" })).statusCode).toBe(400);
    expect((await enviar(app, [linhaValida()], { modalidades: "{nao e json" })).statusCode).toBe(400);
    await app.close();
  });

  it("rejects a sheet with no id, or with an id that is not a plain token", async () => {
    const { deps } = buildDeps();
    const app = buildServer({ deps });

    expect((await enviar(app, [linhaValida()], { id: "" })).statusCode).toBe(400);
    expect((await enviar(app, [linhaValida()], { id: "../outro" })).statusCode).toBe(400);
    await app.close();
  });

  // Two uploads under one id would have the second overwrite the first one's
  // result while the log may still be waiting on it.
  it("refuses an id that is already in use", async () => {
    const { deps } = buildDeps();
    const app = buildServer({ deps });

    expect((await enviar(app, [linhaValida()], { id: "repetido" })).statusCode).toBe(200);
    const res = await enviar(app, [linhaValida()], { id: "repetido" });

    expect(res.statusCode).toBe(409);
    expect(res.json().sucesso).toBe(false);
    await app.close();
  });

  it("answers ok on the health check", async () => {
    const { deps } = buildDeps();
    const app = buildServer({ deps });

    const res = await app.inject({ method: "GET", url: "/api/v1/saude" });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    await app.close();
  });
});

describe("GET /api/v1/planilha/:id", () => {
  // The service was restarted, the result expired, or the id is just wrong: the
  // log has to tell the user to send the sheet again, not wait forever.
  it("answers 404 for a sheet it does not know", async () => {
    const { deps } = buildDeps();
    const app = buildServer({ deps });

    const res = await consultar(app, "desconhecida");

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ sucesso: false });
    await app.close();
  });
});

describe("shared-token authentication", () => {
  // `null` builds the server with no token at all.
  async function comToken(cabecalhos: Record<string, string> = {}, token: string | null = "segredo") {
    const { deps } = buildDeps();
    const app = buildServer({ deps, token: token ?? undefined });

    const envio = await enviar(app, [linhaValida()], {}, cabecalhos);
    const consulta = await consultar(app, "qualquer", cabecalhos);
    await app.close();

    return { envio, consulta };
  }

  it("refuses a request with no token when one is configured", async () => {
    const { envio, consulta } = await comToken();

    expect(envio.statusCode).toBe(401);
    expect(consulta.statusCode).toBe(401);
  });

  it("refuses a wrong token", async () => {
    const { envio } = await comToken({ authorization: "Bearer errado" });

    expect(envio.statusCode).toBe(401);
  });

  it("accepts the right token", async () => {
    const { envio } = await comToken({ authorization: "Bearer segredo" });

    expect(envio.statusCode).toBe(200);
  });

  it("lets everything through when no token is configured", async () => {
    const { envio } = await comToken({}, null);

    expect(envio.statusCode).toBe(200);
  });
});
