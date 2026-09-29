// Process entrypoint. Boots the HTTP service in a single process and shuts it
// down gracefully on SIGINT/SIGTERM. The service holds no database, no cache and
// no queue; the only state is the in-memory map of sheets being quoted and
// results waiting for the log (src/planilha/processamentos.ts). A restart loses
// it, and the log reads that as "send the sheet again". For the same reason this
// runs as a single instance: a second replica would not know the first one's
// sheets.

// dotenv is a dev-only convenience for local runs; in prod the env is injected
// directly (docker-compose env_file / real process env), so a missing module
// must not crash the boot.
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("dotenv").config();
} catch {
  /* no dotenv in this environment — rely on the real process env */
}

import { CotadorHttp } from "./frete/cotadorHttp";
import { CotadorPorConta } from "./frete/cotadorPorConta";
import { CotadorSimulado } from "./frete/cotadorSimulado";
import { CONCORRENCIA_PADRAO } from "./frete/cotarLinhas";
import { Cotador } from "./frete/frete";
import { buildServer } from "./http/server";
import { logError, logInfo } from "./logging/logger";
import { Processamentos } from "./planilha/processamentos";

const PORT = Number(process.env.PORT ?? 3020);
// The shared secret the log sends. Empty leaves the service open, which is what a
// private-network deploy wants.
const API_TOKEN = process.env.API_TOKEN ?? "";
// The quote API (POST /api/v2/cotacao/valores/v2). While it is unset the service
// answers with simulated prices, so the whole path can be exercised.
const FRETE_API_URL = process.env.FRETE_API_URL ?? "";
const FRETE_API_KEY = process.env.FRETE_API_KEY ?? "";
const FRETE_CONCORRENCIA = Number(process.env.FRETE_CONCORRENCIA ?? CONCORRENCIA_PADRAO);

// The account rules (cubage, extra cost, best account) sit on top of whichever
// cotador answers, so the simulated path exercises them too.
const cotador: Cotador = new CotadorPorConta(
  FRETE_API_URL ? new CotadorHttp(FRETE_API_URL, { apiKey: FRETE_API_KEY || undefined }) : new CotadorSimulado(),
);

const app = buildServer({
  deps: { cotador, concorrencia: FRETE_CONCORRENCIA, processamentos: new Processamentos() },
  token: API_TOKEN || undefined,
  logger: true,
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) {
    logError(`${signal} recebido de novo, encerrando à força`);
    process.exit(1);
  }
  shuttingDown = true;

  logInfo(`${signal} recebido, encerrando`);
  try {
    await app.close();
    logInfo("encerrado");
    process.exit(0);
  } catch (err) {
    logError("erro ao encerrar", { err: (err as Error).message });
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() =>
    logInfo(`HTTP ouvindo em :${PORT}`, {
      frete: FRETE_API_URL || "simulado",
      concorrencia: FRETE_CONCORRENCIA,
      autenticado: Boolean(API_TOKEN),
    }),
  )
  .catch((err) => {
    logError("falha ao subir", { err: (err as Error).message });
    process.exit(1);
  });
