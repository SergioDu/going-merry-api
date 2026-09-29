// Prices a whole sheet.
//
// Two things make a thousand rows finish quickly, and neither needs a queue or a
// cache server:
//
//  1. Rows that would ask the same question are asked once. A real import is a
//     thousand rows of a handful of products going to a handful of cities, so the
//     distinct quotes are usually a small fraction of the rows. The map holding
//     them lives inside this call and dies with it — nothing is cached between
//     requests, so a price can never go stale.
//  2. The distinct quotes run concurrently, with a fixed ceiling so a big import
//     does not flood the freight API.
//
// A row that fails validation is never quoted, and a quote that fails takes down
// its own row only — the other 999 still come back.

import { FreightOption, QuoteModality, QuoteRequest, Quoter } from "./freight";
import { fitsLimits } from "./modalities";
import { logInfo } from "../logging/logger";
import { SheetRow } from "../sheet/row";

// How many quotes are allowed in flight at once. Tuned by the caller (main.ts
// reads FREIGHT_CONCURRENCY); this is the default.
export const DEFAULT_CONCURRENCY = 20;

// What the sheet as a whole contributes to every quote: it is the same for all
// rows, so it is not repeated row by row.
export interface QuoteContext {
  originPostalCode: string;
  // The client's modalities, resolved by the log for the carriers picked on the
  // import screen.
  modalities: QuoteModality[];
  // The import's hash in the log. Tags the logs of every quote of the sheet.
  sheetId?: string;
}

export interface QuotedRow extends SheetRow {
  options: FreightOption[];
}

export interface QuoteRowsResult {
  rows: QuotedRow[];
  // How many quotes actually went out, against how many rows came in. On a real
  // sheet this is a small fraction of the rows, and it is the first thing to look
  // at when an import is slow.
  quoteCount: number;
}

function buildRequest(row: SheetRow, context: QuoteContext): QuoteRequest {
  return {
    originPostalCode: context.originPostalCode,
    destinationPostalCode: row.recipient.postalCode,
    weightKg: row.parcel.weightKg,
    heightCm: row.parcel.heightCm,
    widthCm: row.parcel.widthCm,
    lengthCm: row.parcel.lengthCm,
    declaredValue: row.declaredValue,
    withDeliveryReceipt: row.withDeliveryReceipt,
    // The limits depend only on the package, which is part of the key below, so
    // two rows with the same key always end up asking about the same modalities.
    modalities: context.modalities.filter((modality) => fitsLimits(modality, row.parcel)),
  };
}

// Everything the price depends on, and nothing else — the recipient's name or
// phone number must not split two otherwise identical quotes.
function keyOf(request: QuoteRequest): string {
  return [
    request.originPostalCode,
    request.destinationPostalCode,
    request.weightKg,
    request.heightCm,
    request.widthCm,
    request.lengthCm,
    request.declaredValue,
    request.withDeliveryReceipt ? "1" : "0",
  ].join("|");
}

// Runs `task` over every item with at most `limit` of them in flight. Results
// come back in the input's order regardless of who finishes first.
async function withConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));

  return results;
}

interface QuoteGroup {
  request: QuoteRequest;
  lines: number[];
}

export async function quoteRows(
  rows: SheetRow[],
  context: QuoteContext,
  quoter: Quoter,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<QuoteRowsResult> {
  // A row that already failed validation has nothing to price: its CEP or its
  // weight is exactly what is missing.
  const toQuote = rows.filter((row) => row.errors.length === 0);

  // One entry per distinct quote, with the rows it serves, built before anything
  // is dispatched so the duplicates are gone by the time the requests start.
  const groups = new Map<string, QuoteGroup>();
  for (const row of toQuote) {
    const request = buildRequest(row, context);
    const key = keyOf(request);
    const group = groups.get(key);
    if (group) group.lines.push(row.line);
    else groups.set(key, { request, lines: [row.line] });
  }

  // A package no modality can carry is not worth a request: its answer is known.
  // It never reaches the API, so this log is the only trace it leaves.
  const distinct: [string, QuoteGroup][] = [];
  for (const [key, group] of groups) {
    if (group.request.modalities.length > 0) {
      distinct.push([key, group]);
      continue;
    }

    const { weightKg, heightCm, widthCm, lengthCm } = group.request;
    logInfo("linhas sem modalidade para o pacote", {
      sheetId: context.sheetId,
      rows: group.lines,
      parcel: { weightKg, heightCm, widthCm, lengthCm },
    });
  }

  const answers = await withConcurrency(distinct, concurrency, async ([, { request, lines }]) => {
    try {
      const options = await quoter.quote(request, { sheetId: context.sheetId, rows: lines });
      // Cheapest first: the log preselects the first option of the row.
      return { options: [...options].sort((a, b) => a.finalPrice - b.finalPrice), failed: false };
    } catch {
      return { options: [] as FreightOption[], failed: true };
    }
  });

  const byKey = new Map(distinct.map(([key], index) => [key, answers[index]]));

  const quoted = rows.map((row): QuotedRow => {
    if (row.errors.length > 0) return { ...row, options: [] };

    const request = buildRequest(row, context);

    if (request.modalities.length === 0) {
      return { ...row, options: [], errors: [...row.errors, "Nenhuma modalidade compatível"] };
    }

    const answer = byKey.get(keyOf(request));

    if (!answer || answer.failed) {
      return { ...row, options: [], errors: [...row.errors, "Não foi possível cotar o frete desta linha"] };
    }

    if (answer.options.length === 0) {
      return { ...row, options: [], errors: [...row.errors, "Nenhuma modalidade compatível"] };
    }

    return { ...row, options: answer.options };
  });

  return { rows: quoted, quoteCount: distinct.length };
}
