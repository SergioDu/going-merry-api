import Fastify, { FastifyInstance, FastifyServerOptions } from "fastify";
import multipart from "@fastify/multipart";

import { registerPlanilhaRoutes } from "./routes/planilha";
import { ServerDeps } from "./types";

// Common prefix for every route, so the log addresses a versioned namespace
// (POST /api/v1/planilha/processar).
export const API_PREFIX = "/api/v1";

// A thousand rows of the standard template is a few hundred kilobytes; this
// leaves plenty of room while still refusing an upload that is clearly not one.
const TAMANHO_MAXIMO_BYTES = 20 * 1024 * 1024;

export interface BuildServerOptions {
  deps: ServerDeps;
  // Shared secret between the log and this service. Empty (the default) leaves
  // the service open, which is what a private network deploy wants.
  token?: string;
  // Off in tests for quiet output; main.ts turns it on for JSON-to-stdout logs.
  logger?: FastifyServerOptions["logger"];
}

// Builds the Fastify app with its collaborators injected. The app is returned
// un-listened so tests can drive it via `inject` and main.ts can `listen`.
export function buildServer({ deps, token, logger = false }: BuildServerOptions): FastifyInstance {
  const app = Fastify({ logger, bodyLimit: TAMANHO_MAXIMO_BYTES });

  app.register(multipart, { limits: { fileSize: TAMANHO_MAXIMO_BYTES, files: 1 } });

  // A single shared token, checked before anything is read off the wire. Only on
  // when one is configured.
  if (token) {
    app.addHook("onRequest", async (req, reply) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        return reply.code(401).send({ sucesso: false, mensagem: "Não autorizado" });
      }
    });
  }

  app.register(async (instance) => registerPlanilhaRoutes(instance, deps), { prefix: API_PREFIX });

  return app;
}
