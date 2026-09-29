import Fastify, { FastifyInstance, FastifyServerOptions } from "fastify";
import multipart from "@fastify/multipart";

import { registerSheetRoutes } from "./routes/sheets";
import { ServerDeps } from "./types";

// Common prefix for every route. The nginx in front of the onlog services proxies
// /api/v2/<service> as is, so the service owns the full path
// (POST /api/v2/sheets).
export const API_PREFIX = "/api/v2";

// A thousand rows of the standard template is a few hundred kilobytes; this
// leaves plenty of room while still refusing an upload that is clearly not one.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

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
  const app = Fastify({ logger, bodyLimit: MAX_UPLOAD_BYTES });

  app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  // A single shared token, checked before anything is read off the wire. Only on
  // when one is configured.
  if (token) {
    app.addHook("onRequest", async (req, reply) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        return reply.code(401).send({ success: false, message: "Não autorizado" });
      }
    });
  }

  app.register(async (instance) => registerSheetRoutes(instance, deps), { prefix: API_PREFIX });

  return app;
}
