import { describe, expect, it } from "vitest";

import { SheetJobs } from "../../src/sheet/jobs";

function clock(start = 0) {
  let current = start;

  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("SheetJobs", () => {
  it("reports a sheet as being processed until it is finished", () => {
    const jobs = new SheetJobs();

    jobs.start("abc", 10);

    expect(jobs.get("abc")).toMatchObject({ id: "abc", status: "processing", total: 10 });
  });

  it("hands back the result once the sheet is finished", () => {
    const jobs = new SheetJobs();
    jobs.start("abc", 1);

    jobs.complete("abc", { rowsWithErrors: 0, quoteCount: 1, durationMs: 5, rows: [] });

    expect(jobs.get("abc")).toMatchObject({ status: "completed", total: 1, quoteCount: 1, rows: [] });
  });

  it("keeps the reason when processing fails", () => {
    const jobs = new SheetJobs();
    jobs.start("abc", 1);

    jobs.fail("abc", "API de frete fora do ar");

    expect(jobs.get("abc")).toMatchObject({ status: "failed", message: "API de frete fora do ar" });
  });

  it("knows nothing about a sheet it was never given", () => {
    expect(new SheetJobs().get("never")).toBeUndefined();
  });

  it("tells whether an id is already taken", () => {
    const jobs = new SheetJobs();
    jobs.start("abc", 1);

    expect(jobs.has("abc")).toBe(true);
    expect(jobs.has("other")).toBe(false);
  });

  // Nothing is persisted, so a result nobody came back for has to go away on its
  // own — otherwise every sheet ever sent stays in memory.
  it("forgets a sheet once it has been kept long enough", () => {
    const { now, advance } = clock();
    const jobs = new SheetJobs({ ttlMs: 1000, now });
    jobs.start("abc", 1);
    jobs.complete("abc", { rowsWithErrors: 0, quoteCount: 0, durationMs: 0, rows: [] });

    advance(999);
    expect(jobs.get("abc")).toBeDefined();

    advance(2);
    expect(jobs.get("abc")).toBeUndefined();
    expect(jobs.has("abc")).toBe(false);
  });

  it("counts the time a result is kept from when it finished, not from when it started", () => {
    const { now, advance } = clock();
    const jobs = new SheetJobs({ ttlMs: 1000, now });
    jobs.start("abc", 1);

    advance(5000);
    jobs.complete("abc", { rowsWithErrors: 0, quoteCount: 0, durationMs: 0, rows: [] });
    advance(500);

    expect(jobs.get("abc")).toMatchObject({ status: "completed" });
  });
});
