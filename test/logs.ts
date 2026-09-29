import { afterEach, beforeEach, MockInstance, vi } from "vitest";

// What the logger wrote, parsed back from its JSON lines. The suite runs with
// LOG_LEVEL=silent; a test that asserts on logs turns them on for itself.
export function captureLogs(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  let previousLevel: string | undefined;
  let spies: MockInstance[] = [];

  beforeEach(() => {
    lines.length = 0;
    previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "debug";

    const keep = (line: string) => {
      lines.push(JSON.parse(line));
    };
    spies = [
      vi.spyOn(console, "log").mockImplementation(keep),
      vi.spyOn(console, "error").mockImplementation(keep),
    ];
  });

  afterEach(() => {
    process.env.LOG_LEVEL = previousLevel;
    for (const spy of spies) spy.mockRestore();
  });

  return lines;
}
