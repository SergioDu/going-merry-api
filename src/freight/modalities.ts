// The client's modalities, as the log sends them, and the registered limits that
// decide whether a modality can carry a package at all.

import { CubageParams, QuoteModality } from "./freight";

type Raw = Record<string, unknown>;

// PHP sends numbers as strings as often as not; anything unreadable is zero.
function num(raw: Raw, field: string, fallback = 0): number {
  const value = raw[field];
  if (value === undefined || value === null || value === "") return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(raw: Raw, field: string): string {
  const value = raw[field];
  return value === undefined || value === null ? "" : String(value);
}

// The optional fields go on the modality only when the log sent them, so an
// entry without them reads exactly as before.
function optionals(raw: Raw): Partial<QuoteModality> {
  const parsed: Partial<QuoteModality> = {};

  if (num(raw, "quoteCarrierId") > 0) parsed.quoteCarrierId = num(raw, "quoteCarrierId");
  if (raw.extraCost !== undefined) parsed.extraCost = num(raw, "extraCost");
  if (raw.extraCostPct !== undefined) parsed.extraCostPct = num(raw, "extraCostPct");

  const cubage = raw.cubage;
  if (typeof cubage === "object" && cubage !== null) {
    const params: CubageParams = {
      factor: num(cubage as Raw, "factor"),
      exemption: num(cubage as Raw, "exemption") === 1,
      exemptionKg: num(cubage as Raw, "exemptionKg"),
    };
    if (params.factor > 0) parsed.cubage = params;
  }

  return parsed;
}

// Reads the `modalities` field of the upload. Throws when it is not a JSON list —
// that is a bug in the caller, not something to quote around. An entry that does
// not say which carrier and modality it is cannot be quoted and is dropped.
export function parseModalities(content: string): QuoteModality[] {
  const parsed: unknown = JSON.parse(content);

  if (!Array.isArray(parsed)) throw new Error("modalities não é uma lista");

  return parsed
    .filter((item): item is Raw => typeof item === "object" && item !== null)
    .map(
      (raw): QuoteModality => ({
        carrierId: num(raw, "carrierId"),
        modalityId: num(raw, "modalityId"),
        carrierConfigId: num(raw, "carrierConfigId"),
        costTableId: num(raw, "costTableId"),
        priceTableId: num(raw, "priceTableId"),
        profitMargin: num(raw, "profitMargin"),
        finalPriceDiscountPct: num(raw, "finalPriceDiscountPct"),
        marginDiscountPct: num(raw, "marginDiscountPct"),
        fixedDiscount: num(raw, "fixedDiscount"),
        finalPriceSurchargePct: num(raw, "finalPriceSurchargePct"),
        finalPriceFixedSurcharge: num(raw, "finalPriceFixedSurcharge"),
        onlogModalityId: num(raw, "onlogModalityId"),
        name: str(raw, "name"),
        logo: str(raw, "logo"),
        extraDeliveryDays: num(raw, "extraDeliveryDays"),
        // The log closes the PLP by default.
        closesPlp: num(raw, "closesPlp", 1),
        maxWeightKg: num(raw, "maxWeightKg"),
        maxSideCm: num(raw, "maxSideCm"),
        maxDimensionsSumCm: num(raw, "maxDimensionsSumCm"),
        ...optionals(raw),
      }),
    )
    .filter((modality) => modality.carrierId > 0 && modality.modalityId > 0);
}

export interface PackageSize {
  weightKg: number;
  heightCm: number;
  widthCm: number;
  lengthCm: number;
}

// Same rules as fwCotacaoValoresApiOnlog::ValidaLimitesModalidade in the log. The
// declared-value ceiling is not here: it depends on the invoice, and the log
// checks it when it writes the row.
export function fitsLimits(modality: QuoteModality, size: PackageSize): boolean {
  const { weightKg, heightCm, widthCm, lengthCm } = size;

  if (modality.maxWeightKg > 0 && weightKg > modality.maxWeightKg) return false;

  const perSide = modality.maxSideCm;
  if (perSide > 0 && (heightCm > perSide || widthCm > perSide || lengthCm > perSide)) return false;

  if (modality.maxDimensionsSumCm > 0 && heightCm + widthCm + lengthCm > modality.maxDimensionsSumCm) return false;

  return true;
}
