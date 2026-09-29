import { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

import { FreightOption, Quoter } from "../../src/freight/freight";
import { buildServer } from "../../src/http/server";
import { ServerDeps } from "../../src/http/types";
import { SheetJobs } from "../../src/sheet/jobs";

const HEADER = [
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

// A valid row of the standard template; `overrides` breaks one cell at a time.
function validRow(overrides: Record<number, unknown> = {}): unknown[] {
  const row: unknown[] = [
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

  for (const [index, value] of Object.entries(overrides)) row[Number(index)] = value;

  return row;
}

function spreadsheet(rows: unknown[][]): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADER, ...rows]), "Planilha1");

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const BOUNDARY = "----------------------------goingmerryapi";

// Builds the multipart body the log posts: the spreadsheet plus the context
// fields that are the same for the whole sheet. `fileFirst` puts the file ahead
// of the fields, which is the order PHP's curl sends by default.
function multipartBody(
  fields: Record<string, string>,
  file?: { name: string; content: Buffer },
  fileFirst = false,
): Buffer {
  const fieldParts = Object.entries(fields).map(([name, value]) =>
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
  );

  const fileParts = file
    ? [
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
            `Content-Type: application/vnd.ms-excel\r\n\r\n`,
        ),
        file.content,
        Buffer.from("\r\n"),
      ]
    : [];

  const parts = fileFirst ? [...fileParts, ...fieldParts] : [...fieldParts, ...fileParts];

  return Buffer.concat([...parts, Buffer.from(`--${BOUNDARY}--\r\n`)]);
}

// The client's modalities, as the log sends them: one JSON field of the multipart.
const MODALITIES = JSON.stringify([
  { carrierId: 13, modalityId: 3, costTableId: 1, priceTableId: 2, onlogModalityId: 301, name: "SEDEX" },
]);

function option(overrides: Partial<FreightOption> = {}): FreightOption {
  return {
    carrierId: 1,
    modalityId: 10,
    carrierConfigId: null,
    modalityName: "SEDEX",
    carrierLogo: "",
    deliveryDays: 3,
    deliveryTimeText: "3 dias úteis",
    finalPrice: 25.9,
    fullPrice: 25.9,
    cost: 18,
    costWithoutExtras: 18,
    priceWithoutExtras: 25.9,
    insuranceCost: 0,
    insurancePrice: 0,
    deliveryReceiptCost: 0,
    deliveryReceiptPrice: 0,
    closesPlp: 1,
    additionalInfo: "",
    ...overrides,
  };
}

function buildDeps(overrides: Partial<ServerDeps> = {}) {
  const quote = vi.fn<Quoter["quote"]>().mockResolvedValue([option()]);

  const deps: ServerDeps = {
    quoter: { quote },
    concurrency: 20,
    jobs: new SheetJobs(),
    ...overrides,
  };

  return { deps, quote };
}

// The log names each sheet it sends (its import hash); every test sheet gets its own.
let lastId = 0;
function newId(): string {
  lastId++;
  return `sheet-${lastId}`;
}

// Posts a sheet the way the log does. Answers as soon as the sheet is read — the
// quoting goes on in the background.
function send(
  app: FastifyInstance,
  rows: unknown[][],
  fields: Record<string, string> = {},
  headers: Record<string, string> = {},
) {
  const body = multipartBody(
    { id: newId(), originPostalCode: "04571-010", clientId: "99", carrierIds: "1,2", modalities: MODALITIES, ...fields },
    { name: "planilha.xlsx", content: spreadsheet(rows) },
  );

  return app.inject({
    method: "POST",
    url: "/api/v2/sheets",
    payload: body,
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, ...headers },
  });
}

// What the log's polling reads.
function fetchJob(app: FastifyInstance, id: string, headers: Record<string, string> = {}) {
  return app.inject({ method: "GET", url: `/api/v2/sheets/${id}`, headers });
}

// Polls until the sheet is no longer being processed, like the log does.
async function waitForResult(app: FastifyInstance, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const res = await fetchJob(app, id);
    if (res.json().status !== "processing") return res;
    await new Promise((resolve) => setImmediate(resolve));
  }

  throw new Error(`sheet ${id} never finished processing`);
}

// Sends a sheet and waits for its result.
async function processSheet(deps: ServerDeps, rows: unknown[][], fields: Record<string, string> = {}) {
  const app = buildServer({ deps });

  const upload = await send(app, rows, fields);
  expect(upload.statusCode).toBe(200);

  const res = await waitForResult(app, upload.json().id);
  await app.close();

  return res;
}

describe("POST /api/v2/sheets", () => {
  it("answers 200 right away, before the sheet is quoted", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const quote = vi.fn<Quoter["quote"]>().mockImplementation(async () => {
      await held;
      return [option()];
    });
    const { deps } = buildDeps({ quoter: { quote } });
    const app = buildServer({ deps });

    const upload = await send(app, [validRow(), validRow({ 0: "JOAO SOUZA" })], { id: "hash-1" });

    expect(upload.statusCode).toBe(200);
    expect(upload.json()).toEqual({ success: true, id: "hash-1", status: "processing", total: 2 });
    expect((await fetchJob(app, "hash-1")).json()).toMatchObject({ status: "processing", total: 2 });

    release();
    const res = await waitForResult(app, "hash-1");

    expect(res.json()).toMatchObject({ success: true, id: "hash-1", status: "completed", total: 2 });
    await app.close();
  });

  it("parses, validates and quotes every row of the sheet", async () => {
    const { deps, quote } = buildDeps();

    const res = await processSheet(deps, [validRow(), validRow({ 0: "JOAO SOUZA" })]);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0].recipient.name).toBe("MARIA SILVA");
    expect(body.rows[0].options[0].modalityName).toBe("SEDEX");
    expect(quote).toHaveBeenCalled();
  });

  it("forwards the sheet's context into the quote", async () => {
    const { deps, quote } = buildDeps();

    await processSheet(deps, [validRow()], { originPostalCode: "04571-010" });

    const request = quote.mock.calls[0][0];
    expect(request.originPostalCode).toBe("04571-010");
    expect(request.modalities.map((m) => [m.carrierId, m.modalityId, m.onlogModalityId])).toEqual([[13, 3, 301]]);
  });

  // What ties a logged quote back to the import the user is looking at.
  it("tags each quote with the sheet's id and the rows it prices", async () => {
    const { deps, quote } = buildDeps();

    await processSheet(deps, [validRow()], { id: "abc123" });

    expect(quote.mock.calls[0][1]).toEqual({ sheetId: "abc123", rows: [2] });
  });

  // The log writes the temp rows when it finds the sheet finished, in a later
  // request than the upload: it gets back the carriers it sent, not a copy of
  // its own.
  it("hands the sheet's carriers back with the result", async () => {
    const { deps } = buildDeps();

    const res = await processSheet(deps, [validRow()], { carrierIds: "3,4" });

    expect(res.json().carrierIds).toEqual([3, 4]);
  });

  it("keeps the rows in the sheet's order, with their line numbers", async () => {
    const { deps } = buildDeps();

    const res = await processSheet(deps, [validRow(), validRow({ 0: "B" }), validRow({ 0: "C" })]);

    expect(res.json().rows.map((r: { line: number }) => r.line)).toEqual([2, 3, 4]);
  });

  it("returns a bad row with its errors instead of failing the whole sheet", async () => {
    const { deps } = buildDeps();

    const res = await processSheet(deps, [validRow({ 7: "" }), validRow()]);

    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.rowsWithErrors).toBe(1);
    expect(body.rows[0].errors).toContain("CEP do destinatário não pode ser vazio");
    expect(body.rows[0].options).toEqual([]);
    expect(body.rows[1].errors).toEqual([]);
  });

  it("reports how long the sheet took, so a slow import is visible", async () => {
    const { deps } = buildDeps();

    const res = await processSheet(deps, [validRow()]);

    expect(typeof res.json().durationMs).toBe("number");
  });

  // PHP's curl sends the file part before the text fields. The context has to be
  // read whatever order the parts arrive in, or the log's own request is rejected
  // for a CEP it did send. The sheet here is deliberately big enough to arrive in
  // more than one chunk — a small one parses in a single pass and hides the bug.
  it("reads the context even when the file part comes first", async () => {
    const { deps, quote } = buildDeps();
    const app = buildServer({ deps });

    const big = spreadsheet(Array.from({ length: 500 }, (_, i) => validRow({ 0: `DESTINATARIO ${i}` })));
    expect(big.length).toBeGreaterThan(64 * 1024);

    const upload = await app.inject({
      method: "POST",
      url: "/api/v2/sheets",
      payload: multipartBody(
        { id: "file-first", originPostalCode: "04571-010", clientId: "99", carrierIds: "1,2", modalities: MODALITIES },
        { name: "planilha.xlsx", content: big },
        true,
      ),
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    });

    expect(upload.statusCode).toBe(200);
    expect(upload.json().total).toBe(500);

    await waitForResult(app, "file-first");
    expect(quote.mock.calls[0][0]).toMatchObject({ originPostalCode: "04571-010", modalities: [{ onlogModalityId: 301 }] });
    await app.close();
  });

  it("reports how many quotes the sheet really cost", async () => {
    const { deps, quote } = buildDeps();

    // Three rows, two of them identical: two quotes.
    const res = await processSheet(deps, [validRow(), validRow({ 0: "OUTRO NOME" }), validRow({ 12: 9 })]);

    expect(res.json().quoteCount).toBe(2);
    expect(quote).toHaveBeenCalledTimes(2);
  });

  it("rejects a request with no file", async () => {
    const { deps } = buildDeps();
    const app = buildServer({ deps });

    const res = await app.inject({
      method: "POST",
      url: "/api/v2/sheets",
      payload: multipartBody({ id: newId(), originPostalCode: "04571-010", clientId: "99", carrierIds: "1", modalities: MODALITIES }),
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/arquivo/i);
    await app.close();
  });

  it("rejects a file that is not a spreadsheet with the reason", async () => {
    const { deps } = buildDeps();
    const app = buildServer({ deps });

    const res = await app.inject({
      method: "POST",
      url: "/api/v2/sheets",
      payload: multipartBody(
        { id: newId(), originPostalCode: "04571-010", clientId: "99", carrierIds: "1", modalities: MODALITIES },
        { name: "foto.png", content: Buffer.from("nao sou planilha") },
      ),
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/planilha/i);
    await app.close();
  });

  it("rejects a request missing the sheet's context", async () => {
    const { deps } = buildDeps();
    const app = buildServer({ deps });

    expect((await send(app, [validRow()], { originPostalCode: "" })).statusCode).toBe(400);
    expect((await send(app, [validRow()], { clientId: "" })).statusCode).toBe(400);
    expect((await send(app, [validRow()], { carrierIds: "" })).statusCode).toBe(400);
    await app.close();
  });

  // Without the client's modalities there is nothing to quote with: the log has
  // to say which ones the client can use and at what price.
  it("rejects a request with no modality, or with modalities that are not a JSON list", async () => {
    const { deps } = buildDeps();
    const app = buildServer({ deps });

    const noModality = await send(app, [validRow()], { modalities: "[]" });
    expect(noModality.statusCode).toBe(400);
    expect(noModality.json().message).toMatch(/modalidade/i);

    expect((await send(app, [validRow()], { modalities: "" })).statusCode).toBe(400);
    expect((await send(app, [validRow()], { modalities: "{not json" })).statusCode).toBe(400);
    await app.close();
  });

  it("rejects a sheet with no id, or with an id that is not a plain token", async () => {
    const { deps } = buildDeps();
    const app = buildServer({ deps });

    expect((await send(app, [validRow()], { id: "" })).statusCode).toBe(400);
    expect((await send(app, [validRow()], { id: "../other" })).statusCode).toBe(400);
    await app.close();
  });

  // Two uploads under one id would have the second overwrite the first one's
  // result while the log may still be waiting on it.
  it("refuses an id that is already in use", async () => {
    const { deps } = buildDeps();
    const app = buildServer({ deps });

    expect((await send(app, [validRow()], { id: "repeated" })).statusCode).toBe(200);
    const res = await send(app, [validRow()], { id: "repeated" });

    expect(res.statusCode).toBe(409);
    expect(res.json().success).toBe(false);
    await app.close();
  });
});

describe("GET /api/v2/sheets/health", () => {
  it("answers ok", async () => {
    const { deps } = buildDeps();
    const app = buildServer({ deps });

    const res = await app.inject({ method: "GET", url: "/api/v2/sheets/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    await app.close();
  });
});

describe("GET /api/v2/sheets/:id", () => {
  // The service was restarted, the result expired, or the id is just wrong: the
  // log has to tell the user to send the sheet again, not wait forever.
  it("answers 404 for a sheet it does not know", async () => {
    const { deps } = buildDeps();
    const app = buildServer({ deps });

    const res = await fetchJob(app, "unknown");

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ success: false });
    await app.close();
  });
});

describe("shared-token authentication", () => {
  // `null` builds the server with no token at all.
  async function withToken(headers: Record<string, string> = {}, token: string | null = "secret") {
    const { deps } = buildDeps();
    const app = buildServer({ deps, token: token ?? undefined });

    const upload = await send(app, [validRow()], {}, headers);
    const lookup = await fetchJob(app, "any", headers);
    await app.close();

    return { upload, lookup };
  }

  it("refuses a request with no token when one is configured", async () => {
    const { upload, lookup } = await withToken();

    expect(upload.statusCode).toBe(401);
    expect(lookup.statusCode).toBe(401);
  });

  it("refuses a wrong token", async () => {
    const { upload } = await withToken({ authorization: "Bearer wrong" });

    expect(upload.statusCode).toBe(401);
  });

  it("accepts the right token", async () => {
    const { upload } = await withToken({ authorization: "Bearer secret" });

    expect(upload.statusCode).toBe(200);
  });

  it("lets everything through when no token is configured", async () => {
    const { upload } = await withToken({}, null);

    expect(upload.statusCode).toBe(200);
  });
});
