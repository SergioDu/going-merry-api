// Structured JSON logging to stdout/stderr, one line per event, so the existing
// Alloy → Loki → Grafana stack picks it up like the other onlog services. Domain
// messages are prefixed with [planilha].
//
// The level is read from LOG_LEVEL (debug < info < warn < error < silent) at call
// time, defaulting to info; tests set it to "silent" to keep output quiet.
export type LogFields = Record<string, unknown>;

const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function threshold(): number {
  return LEVELS[process.env.LOG_LEVEL ?? ""] ?? LEVELS.info;
}

function emit(write: (line: string) => void, level: string, msg: string, fields: LogFields): void {
  if (LEVELS[level] < threshold()) return;
  write(JSON.stringify({ level, time: new Date().toISOString(), msg: `[planilha] ${msg}`, ...fields }));
}

export function logDebug(msg: string, fields: LogFields = {}): void {
  emit(console.log, "debug", msg, fields);
}

export function logInfo(msg: string, fields: LogFields = {}): void {
  emit(console.log, "info", msg, fields);
}

export function logError(msg: string, fields: LogFields = {}): void {
  emit(console.error, "error", msg, fields);
}
