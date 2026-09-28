import { afterEach, beforeEach, MockInstance, vi } from "vitest";

// What the logger wrote, parsed back from its JSON lines. The suite runs with
// LOG_LEVEL=silent; a test that asserts on logs turns them on for itself.
export function capturarLogs(): Record<string, unknown>[] {
  const linhas: Record<string, unknown>[] = [];
  let nivelAnterior: string | undefined;
  let espioes: MockInstance[] = [];

  beforeEach(() => {
    linhas.length = 0;
    nivelAnterior = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "debug";

    const guardar = (linha: string) => {
      linhas.push(JSON.parse(linha));
    };
    espioes = [
      vi.spyOn(console, "log").mockImplementation(guardar),
      vi.spyOn(console, "error").mockImplementation(guardar),
    ];
  });

  afterEach(() => {
    process.env.LOG_LEVEL = nivelAnterior;
    for (const espiao of espioes) espiao.mockRestore();
  });

  return linhas;
}
