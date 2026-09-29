import { describe, expect, it } from "vitest";

import { fitsLimits, parseModalities } from "../../src/freight/modalities";
import { QuoteModality } from "../../src/freight/freight";

function modality(overrides: Partial<QuoteModality> = {}): QuoteModality {
  return {
    carrierId: 13,
    modalityId: 3,
    carrierConfigId: 0,
    costTableId: 1,
    priceTableId: 2,
    profitMargin: 20,
    finalPriceDiscountPct: 0,
    marginDiscountPct: 0,
    fixedDiscount: 0,
    finalPriceSurchargePct: 0,
    finalPriceFixedSurcharge: 0,
    onlogModalityId: 301,
    name: "SEDEX",
    logo: "assets/img/logo_fornecedores/correios.png",
    extraDeliveryDays: 0,
    closesPlp: 1,
    maxWeightKg: 0,
    maxSideCm: 0,
    maxDimensionsSumCm: 0,
    ...overrides,
  };
}

const PACKAGE = { weightKg: 2, heightCm: 10, widthCm: 20, lengthCm: 30 };

// The log sends the client's modalities as a JSON field of the multipart
// request. PHP is loose with types, so numbers may arrive as strings.
describe("parseModalities", () => {
  it("reads the modalities the log sends", () => {
    const [parsed] = parseModalities(JSON.stringify([modality()]));

    expect(parsed).toEqual(modality());
  });

  it("accepts numbers written as strings, the way PHP tends to send them", () => {
    const [parsed] = parseModalities(
      JSON.stringify([{ ...modality(), carrierId: "14", profitMargin: "12.5", maxWeightKg: "30" }]),
    );

    expect(parsed.carrierId).toBe(14);
    expect(parsed.profitMargin).toBe(12.5);
    expect(parsed.maxWeightKg).toBe(30);
  });

  it("defaults the pricing and limit fields the log leaves out", () => {
    const [parsed] = parseModalities(
      JSON.stringify([{ carrierId: 14, modalityId: 3, onlogModalityId: 401, name: "PACKAGE" }]),
    );

    expect(parsed.carrierConfigId).toBe(0);
    expect(parsed.profitMargin).toBe(0);
    expect(parsed.extraDeliveryDays).toBe(0);
    expect(parsed.closesPlp).toBe(1);
    expect(parsed.maxWeightKg).toBe(0);
    expect(parsed.logo).toBe("");
  });

  it("reads the carrier an OnlogRed modality is quoted as", () => {
    const [parsed] = parseModalities(JSON.stringify([{ ...modality(), carrierId: 132226, quoteCarrierId: "13" }]));

    expect(parsed.carrierId).toBe(132226);
    expect(parsed.quoteCarrierId).toBe(13);
  });

  // Jadlog: what the log resolved from the account each entry is quoted on.
  it("reads the account's extra cost and cubage parameters", () => {
    const [parsed] = parseModalities(
      JSON.stringify([
        {
          ...modality(),
          extraCost: "2",
          extraCostPct: "0",
          cubage: { factor: "3333", exemption: "1", exemptionKg: "5.0" },
        },
      ]),
    );

    expect(parsed.extraCost).toBe(2);
    expect(parsed.extraCostPct).toBe(0);
    expect(parsed.cubage).toEqual({ factor: 3333, exemption: true, exemptionKg: 5 });
  });

  it("leaves out cubage parameters without a factor to divide by", () => {
    const [withoutObject, withoutFactor] = parseModalities(
      JSON.stringify([
        { ...modality(), cubage: null },
        { ...modality(), cubage: { factor: 0, exemption: 0, exemptionKg: 0 } },
      ]),
    );

    expect(withoutObject.cubage).toBeUndefined();
    expect(withoutFactor.cubage).toBeUndefined();
  });

  it("drops an entry that does not say which carrier and modality it is", () => {
    const parsed = parseModalities(JSON.stringify([modality(), { carrierId: 0, modalityId: 3 }, { carrierId: 14 }]));

    expect(parsed).toHaveLength(1);
  });

  it("refuses something that is not a JSON list", () => {
    expect(() => parseModalities("")).toThrow();
    expect(() => parseModalities("{")).toThrow();
    expect(() => parseModalities('{"carrierId": 13}')).toThrow();
  });
});

// The limits registered on the modality. The quote API does not know the
// client's registration, so they are checked here, before asking.
describe("fitsLimits", () => {
  it("lets through a modality with no limits registered", () => {
    expect(fitsLimits(modality(), PACKAGE)).toBe(true);
  });

  it("refuses a package heavier than the modality's maximum weight", () => {
    expect(fitsLimits(modality({ maxWeightKg: 1 }), PACKAGE)).toBe(false);
    expect(fitsLimits(modality({ maxWeightKg: 2 }), PACKAGE)).toBe(true);
  });

  it("refuses a package with any side over the maximum per side", () => {
    expect(fitsLimits(modality({ maxSideCm: 25 }), PACKAGE)).toBe(false);
    expect(fitsLimits(modality({ maxSideCm: 30 }), PACKAGE)).toBe(true);
  });

  it("refuses a package whose sides add up to more than the maximum", () => {
    expect(fitsLimits(modality({ maxDimensionsSumCm: 59 }), PACKAGE)).toBe(false);
    expect(fitsLimits(modality({ maxDimensionsSumCm: 60 }), PACKAGE)).toBe(true);
  });
});
