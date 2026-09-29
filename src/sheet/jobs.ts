// Where a sheet waits between being received and being read back by the log.
//
// The upload answers as soon as the sheet is read; the quoting goes on in the
// background and the log polls for the result. That result has to live
// somewhere in between, and it lives here, in memory: no database, no Redis.
// The price of that is spelled out — a restart loses what was in flight, and a
// second replica would not see the first one's sheets. The log treats an
// unknown sheet as "send it again", so both end the same honest way.

import { QuotedRow } from "../freight/quoteRows";

// A finished result is kept this long for the log to come and get it. Long
// enough to survive the user closing the tab and coming back later the same day.
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export interface SheetResult {
  rowsWithErrors: number;
  // Distinct quotes actually sent to the freight API for this sheet.
  quoteCount: number;
  durationMs: number;
  rows: QuotedRow[];
}

export type SheetJob =
  | { id: string; status: "processing"; total: number; carrierIds: number[] }
  | ({ id: string; status: "completed"; total: number; carrierIds: number[] } & SheetResult)
  | { id: string; status: "failed"; total: number; carrierIds: number[]; message: string };

interface Entry {
  job: SheetJob;
  // When it stops being kept. A sheet still being processed has none: it always
  // finishes, one way or the other, and only then does the clock start.
  expiresAt: number | null;
}

export interface SheetJobsOptions {
  ttlMs?: number;
  now?: () => number;
}

export class SheetJobs {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor({ ttlMs = DEFAULT_TTL_MS, now = Date.now }: SheetJobsOptions = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  start(id: string, total: number, carrierIds: number[] = []): void {
    this.entries.set(id, { job: { id, status: "processing", total, carrierIds }, expiresAt: null });
  }

  complete(id: string, result: SheetResult): void {
    const current = this.entries.get(id);
    if (!current) return;

    const { total, carrierIds } = current.job;
    this.finish({ id, status: "completed", total, carrierIds, ...result });
  }

  fail(id: string, message: string): void {
    const current = this.entries.get(id);
    if (!current) return;

    const { total, carrierIds } = current.job;
    this.finish({ id, status: "failed", total, carrierIds, message });
  }

  get(id: string): SheetJob | undefined {
    this.evictExpired();

    return this.entries.get(id)?.job;
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  private finish(job: SheetJob): void {
    this.entries.set(job.id, { job, expiresAt: this.now() + this.ttlMs });
  }

  // Swept on read rather than on a timer: nothing to stop on shutdown, and a
  // quiet service holds on to at most what it held when it went quiet.
  private evictExpired(): void {
    const now = this.now();

    for (const [id, entry] of this.entries) {
      if (entry.expiresAt !== null && entry.expiresAt < now) this.entries.delete(id);
    }
  }
}
