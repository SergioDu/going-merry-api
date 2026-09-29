import { describe, expect, it } from "vitest";

import { SimulatedQuoter } from "../../src/freight/simulatedQuoter";
import { QuoteModality, QuoteRequest } from "../../src/freight/freight";

function modality(carrierId: number, onlogModalityId: number): QuoteModality {
  return {
    carrierId,
    modalityId: 1,
    carrierConfigId: 0,
    costTableId: 0,
    priceTableId: 0,
    profitMargin: 0,
    finalPriceDiscountPct: 0,
    marginDiscountPct: 0,
    fixedDiscount: 0,
    finalPriceSurchargePct: 0,
    finalPriceFixedSurcharge: 0,
    onlogModalityId,
    name: "PAC",
    logo: "",
    extraDeliveryDays: 0,
    closesPlp: 1,
    maxWeightKg: 0,
    maxSideCm: 0,
    maxDimensionsSumCm: 0,
  };
}

function request(overrides: Partial<QuoteRequest> = {}): QuoteRequest {
  return {
    originPostalCode: "04571-010",
    destinationPostalCode: "01001-000",
    weightKg: 1,
    heightCm: 10,
    widthCm: 20,
    lengthCm: 30,
    declaredValue: 0,
    withDeliveryReceipt: false,
    modalities: [modality(13, 301), modality(14, 401)],
    ...overrides,
  };
}

// Stands in for the freight endpoint until it exists, so the whole pipeline —
// upload, parse, validate, quote, respond — can be exercised and load-tested
// today. It must never be mistaken for real pricing.
describe("SimulatedQuoter", () => {
  it("prices one option per modality it was asked about", async () => {
    const options = await new SimulatedQuoter().quote(
      request({ modalities: [modality(13, 301), modality(14, 401), modality(1, 101)] }),
    );

    expect(options.map((o) => [o.carrierId, o.modalityId])).toEqual([
      [13, 301],
      [14, 401],
      [1, 101],
    ]);
  });

  it("answers the same price for the same package, so a run is reproducible", async () => {
    const quoter = new SimulatedQuoter();

    const first = await quoter.quote(request());
    const second = await quoter.quote(request());

    expect(first).toEqual(second);
  });

  it("charges more for a heavier package", async () => {
    const quoter = new SimulatedQuoter();

    const light = await quoter.quote(request({ weightKg: 1 }));
    const heavy = await quoter.quote(request({ weightKg: 10 }));

    expect(heavy[0].finalPrice).toBeGreaterThan(light[0].finalPrice);
  });

  it("charges the declared-value insurance only when there is one", async () => {
    const quoter = new SimulatedQuoter();

    expect((await quoter.quote(request({ declaredValue: 0 })))[0].insurancePrice).toBe(0);
    expect((await quoter.quote(request({ declaredValue: 100 })))[0].insurancePrice).toBeGreaterThan(0);
  });

  it("charges the return receipt only when the row asked for one", async () => {
    const quoter = new SimulatedQuoter();

    expect((await quoter.quote(request({ withDeliveryReceipt: false })))[0].deliveryReceiptPrice).toBe(0);
    expect((await quoter.quote(request({ withDeliveryReceipt: true })))[0].deliveryReceiptPrice).toBeGreaterThan(0);
  });

  it("marks every option as simulated so a fake price cannot pass for a real one", async () => {
    const [option] = await new SimulatedQuoter().quote(request());

    expect(option.modalityName).toMatch(/SIMULAD/i);
    expect(option.additionalInfo).toMatch(/simulad/i);
  });

  it("returns nothing when there is no modality to price", async () => {
    expect(await new SimulatedQuoter().quote(request({ modalities: [] }))).toEqual([]);
  });
});
