// The spreadsheet routes. The log posts the sheet a client uploaded and gets an
// answer as soon as the sheet has been read; the quoting — the slow part — goes on
// in the background, and the log polls GET /sheets/:id until the sheet is
// finished. What it gets back then is one normalized, validated and priced row
// per sheet line, in the sheet's order.
//
// What comes back is data, not markup: the log keeps rendering its own import
// grid and writing its own temp rows. That is also why this service has no
// database — a result is only held in memory until the log comes for it.
//
// The messages in the responses are Portuguese on purpose: the log shows them to
// the user as they are.

import { FastifyError, FastifyInstance } from "fastify";

import { QuoteModality } from "../../freight/freight";
import { parseModalities } from "../../freight/modalities";
import { quoteRows } from "../../freight/quoteRows";
import { logError, logInfo } from "../../logging/logger";
import { readSheet } from "../../sheet/reader";
import { mapRow } from "../../sheet/row";
import { ServerDeps } from "../types";

// A sheet this big is a mistake, not an import. The ceiling is on rows rather
// than bytes so the message can say something useful.
const MAX_ROWS = 5000;

// The log names the sheet with its own import hash, and polls by it. It ends up in
// a URL, so anything but a plain token is refused.
const VALID_ID = /^[A-Za-z0-9_-]{1,64}$/;

function failure(message: string) {
  return { success: false as const, message };
}

export function registerSheetRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // Registered before /sheets/:id; Fastify matches the static path first.
  app.get("/sheets/health", async () => ({ status: "ok" }));

  app.post("/sheets", async (req, reply) => {
    const startedAt = Date.now();

    // One multipart request: the spreadsheet, plus the context that is the same
    // for every row in it.
    //
    // The parts are walked one by one rather than read off `req.file().fields`,
    // because the order they arrive in is the caller's business: PHP's curl puts
    // the file first, and a field that comes after a file has not been parsed yet
    // by the time that file resolves. Walking the parts reads the whole request
    // whatever order it was written in.
    const fields: Record<string, string> = {};
    let content: Buffer | null = null;

    for await (const part of req.parts()) {
      if (part.type === "file") {
        content = await part.toBuffer();
      } else {
        fields[part.fieldname] = String(part.value ?? "");
      }
    }

    if (!content) {
      return reply.code(400).send(failure("Envie o arquivo da planilha no campo 'file'"));
    }

    const id = (fields.id ?? "").trim();
    const originPostalCode = (fields.originPostalCode ?? "").trim();
    const clientId = Number((fields.clientId ?? "").trim());
    const carrierIds = (fields.carrierIds ?? "")
      .split(",")
      .map((carrierId) => Number(carrierId.trim()))
      .filter((carrierId) => Number.isInteger(carrierId) && carrierId > 0);

    if (!VALID_ID.test(id)) return reply.code(400).send(failure("Identificador da planilha inválido"));
    if (deps.jobs.has(id)) {
      return reply.code(409).send(failure("Já existe uma planilha com esse identificador"));
    }
    if (originPostalCode === "") return reply.code(400).send(failure("CEP de origem não informado"));
    if (!Number.isInteger(clientId) || clientId <= 0) return reply.code(400).send(failure("Cliente não informado"));
    if (carrierIds.length === 0) return reply.code(400).send(failure("Nenhum operador selecionado"));

    // The client's modalities with their pricing, resolved by the log for the
    // carriers picked on the screen. Without them there is nothing to quote with.
    let modalities: QuoteModality[];
    try {
      modalities = parseModalities(fields.modalities ?? "");
    } catch {
      return reply.code(400).send(failure("Modalidades do cliente em formato inválido"));
    }
    if (modalities.length === 0) {
      return reply.code(400).send(failure("Nenhuma modalidade com precificação para as transportadoras selecionadas"));
    }

    let rawRows;
    try {
      rawRows = readSheet(content);
    } catch (e) {
      // A wrong or corrupt upload is the user's problem to fix, not a server
      // failure: hand the reason back so the log can show it.
      return reply.code(400).send(failure((e as Error).message));
    }

    if (rawRows.length > MAX_ROWS) {
      return reply
        .code(400)
        .send(failure(`A planilha tem ${rawRows.length} linhas. O limite por arquivo é de ${MAX_ROWS}`));
    }

    logInfo("planilha recebida", {
      id,
      clientId,
      originPostalCode,
      carrierIds,
      modalities: modalities.length,
      rows: rawRows.length,
    });

    const rows = rawRows.map((raw) => mapRow(raw.cells, raw.line));

    deps.jobs.start(id, rows.length, carrierIds);

    // Not awaited: the answer goes out now, and the log polls for the result.
    quoteRows(rows, { originPostalCode, modalities, sheetId: id }, deps.quoter, deps.concurrency)
      .then(({ rows: quoted, quoteCount }) => {
        const rowsWithErrors = quoted.filter((row) => row.errors.length > 0).length;
        const durationMs = Date.now() - startedAt;

        deps.jobs.complete(id, { rowsWithErrors, quoteCount, durationMs, rows: quoted });
        logInfo("planilha processada", { id, clientId, total: quoted.length, rowsWithErrors, quoteCount, durationMs });
      })
      .catch((e: Error) => {
        deps.jobs.fail(id, "Erro ao processar a planilha");
        logError("falha ao processar a planilha", { id, clientId, err: e.message });
      });

    return reply.code(200).send({ success: true, id, status: "processing", total: rows.length });
  });

  app.get<{ Params: { id: string } }>("/sheets/:id", async (req, reply) => {
    const job = deps.jobs.get(req.params.id);

    if (!job) {
      return reply.code(404).send(failure("Processamento da planilha não encontrado"));
    }

    return reply.code(200).send({ success: true, ...job });
  });

  // Surfaces the reason a sheet blew up instead of a bare 500 in the log's UI.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    logError("falha ao processar a planilha", { err: err.message });

    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send(failure(err.message));
    }

    return reply.code(500).send(failure("Erro ao processar a planilha"));
  });
}
