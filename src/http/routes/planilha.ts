// The spreadsheet routes. The log posts the sheet a client uploaded and gets an
// answer as soon as the sheet has been read; the quoting — the slow part — goes on
// in the background, and the log polls GET /planilha/:id until the sheet is
// finished. What it gets back then is one normalized, validated and priced row
// per sheet line, in the sheet's order.
//
// What comes back is data, not markup: the log keeps rendering its own import
// grid and writing its own temp rows. That is also why this service has no
// database — a result is only held in memory until the log comes for it.

import { FastifyError, FastifyInstance } from "fastify";

import { cotarLinhas } from "../../frete/cotarLinhas";
import { ModalidadeCotacao } from "../../frete/frete";
import { lerModalidades } from "../../frete/modalidades";
import { logError, logInfo } from "../../logging/logger";
import { lerPlanilha } from "../../planilha/leitor";
import { mapearLinha } from "../../planilha/linha";
import { ServerDeps } from "../types";

// A sheet this big is a mistake, not an import. The ceiling is on rows rather
// than bytes so the message can say something useful.
const MAXIMO_LINHAS = 5000;

// The log names the sheet with its own import hash, and polls by it. It ends up in
// a URL, so anything but a plain token is refused.
const ID_VALIDO = /^[A-Za-z0-9_-]{1,64}$/;

function erro(mensagem: string) {
  return { sucesso: false as const, mensagem };
}

export function registerPlanilhaRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/saude", async () => ({ status: "ok" }));

  app.post("/planilha/processar", async (req, reply) => {
    const inicio = Date.now();

    // One multipart request: the spreadsheet, plus the context that is the same
    // for every row in it.
    //
    // The parts are walked one by one rather than read off `req.file().fields`,
    // because the order they arrive in is the caller's business: PHP's curl puts
    // the file first, and a field that comes after a file has not been parsed yet
    // by the time that file resolves. Walking the parts reads the whole request
    // whatever order it was written in.
    const campos: Record<string, string> = {};
    let conteudo: Buffer | null = null;

    for await (const parte of req.parts()) {
      if (parte.type === "file") {
        conteudo = await parte.toBuffer();
      } else {
        campos[parte.fieldname] = String(parte.value ?? "");
      }
    }

    if (!conteudo) {
      return reply.code(400).send(erro("Envie o arquivo da planilha no campo 'arquivo'"));
    }

    const id = (campos.id ?? "").trim();
    const cepOrigem = (campos.cepOrigem ?? "").trim();
    const idCliente = Number((campos.idCliente ?? "").trim());
    const operadores = (campos.operadores ?? "")
      .split(",")
      .map((id) => Number(id.trim()))
      .filter((id) => Number.isInteger(id) && id > 0);

    if (!ID_VALIDO.test(id)) return reply.code(400).send(erro("Identificador da planilha inválido"));
    if (deps.processamentos.existe(id)) {
      return reply.code(409).send(erro("Já existe uma planilha com esse identificador"));
    }
    if (cepOrigem === "") return reply.code(400).send(erro("CEP de origem não informado"));
    if (!Number.isInteger(idCliente) || idCliente <= 0) return reply.code(400).send(erro("Cliente não informado"));
    if (operadores.length === 0) return reply.code(400).send(erro("Nenhum operador selecionado"));

    // The client's modalities with their pricing, resolved by the log for the
    // carriers picked on the screen. Without them there is nothing to quote with.
    let modalidades: ModalidadeCotacao[];
    try {
      modalidades = lerModalidades(campos.modalidades ?? "");
    } catch {
      return reply.code(400).send(erro("Modalidades do cliente em formato inválido"));
    }
    if (modalidades.length === 0) {
      return reply.code(400).send(erro("Nenhuma modalidade com precificação para as transportadoras selecionadas"));
    }

    let brutas;
    try {
      brutas = lerPlanilha(conteudo);
    } catch (e) {
      // A wrong or corrupt upload is the user's problem to fix, not a server
      // failure: hand the reason back so the log can show it.
      return reply.code(400).send(erro((e as Error).message));
    }

    if (brutas.length > MAXIMO_LINHAS) {
      return reply
        .code(400)
        .send(erro(`A planilha tem ${brutas.length} linhas. O limite por arquivo é de ${MAXIMO_LINHAS}`));
    }

    logInfo("planilha recebida", {
      id,
      idCliente,
      cepOrigem,
      operadores,
      modalidades: modalidades.length,
      linhas: brutas.length,
    });

    const linhas = brutas.map((bruta) => mapearLinha(bruta.celulas, bruta.linha));

    deps.processamentos.iniciar(id, linhas.length, operadores);

    // Not awaited: the answer goes out now, and the log polls for the result.
    cotarLinhas(linhas, { cepOrigem, modalidades }, deps.cotador, deps.concorrencia)
      .then(({ linhas: cotadas, cotacoes }) => {
        const comErro = cotadas.filter((linha) => linha.erros.length > 0).length;
        const tempoMs = Date.now() - inicio;

        deps.processamentos.concluir(id, { comErro, cotacoes, tempoMs, linhas: cotadas });
        logInfo("planilha processada", { id, idCliente, total: cotadas.length, comErro, cotacoes, tempoMs });
      })
      .catch((e: Error) => {
        deps.processamentos.falhar(id, "Erro ao processar a planilha");
        logError("falha ao processar a planilha", { id, idCliente, err: e.message });
      });

    return reply.code(200).send({ sucesso: true, id, status: "processando", total: linhas.length });
  });

  app.get<{ Params: { id: string } }>("/planilha/:id", async (req, reply) => {
    const processamento = deps.processamentos.consultar(req.params.id);

    if (!processamento) {
      return reply.code(404).send(erro("Processamento da planilha não encontrado"));
    }

    return reply.code(200).send({ sucesso: true, ...processamento });
  });

  // Surfaces the reason a sheet blew up instead of a bare 500 in the log's UI.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    logError("falha ao processar a planilha", { err: err.message });

    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send(erro(err.message));
    }

    return reply.code(500).send(erro("Erro ao processar a planilha"));
  });
}
