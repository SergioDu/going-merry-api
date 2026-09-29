import { describe, expect, it, vi } from "vitest";

import { PerAccountQuoter } from "../../src/freight/perAccountQuoter";
import { FreightOption, QuoteModality, QuoteRequest, Quoter } from "../../src/freight/freight";

function modality(overrides: Partial<QuoteModality> = {}): QuoteModality {
  return {
    carrierId: 14,
    modalityId: 3,
    carrierConfigId: 127,
    costTableId: 0,
    priceTableId: 0,
    profitMargin: 105,
    finalPriceDiscountPct: 0,
    marginDiscountPct: 0,
    fixedDiscount: 0,
    finalPriceSurchargePct: 0,
    finalPriceFixedSurcharge: 0,
    onlogModalityId: 401,
    name: "PACKAGE",
    logo: "",
    extraDeliveryDays: 0,
    closesPlp: 1,
    maxWeightKg: 0,
    maxSideCm: 0,
    maxDimensionsSumCm: 0,
    ...overrides,
  };
}

// 10 × 20 × 30 = 6000 cm³: 1 kg at factor 6000, 1.8 kg at factor 3333.
function request(overrides: Partial<QuoteRequest> = {}): QuoteRequest {
  return {
    originPostalCode: "01523-000",
    destinationPostalCode: "01523-000",
    weightKg: 0.3,
    heightCm: 10,
    widthCm: 20,
    lengthCm: 30,
    declaredValue: 0,
    withDeliveryReceipt: false,
    modalities: [modality()],
    ...overrides,
  };
}

function option(overrides: Partial<FreightOption> = {}): FreightOption {
  return {
    carrierId: 14,
    modalityId: 401,
    carrierConfigId: 127,
    modalityName: "PACKAGE",
    carrierLogo: "",
    deliveryDays: 2,
    deliveryTimeText: "ENTREGA EM 2 DIAS ÚTEIS",
    finalPrice: 12.59,
    fullPrice: 12.59,
    cost: 6.14,
    costWithoutExtras: 6.14,
    priceWithoutExtras: 12.59,
    insuranceCost: 0,
    insurancePrice: 0,
    deliveryReceiptCost: 0,
    deliveryReceiptPrice: 0,
    closesPlp: 1,
    additionalInfo: "",
    ...overrides,
  };
}

function inner(answers: (request: QuoteRequest) => FreightOption[] = () => []) {
  const quote = vi.fn(async (request: QuoteRequest) => answers(request));
  return { quoter: { quote } as Quoter, quote };
}

describe("PerAccountQuoter — cubage", () => {
  it("quotes at the real weight when no modality has cubage parameters", async () => {
    const { quoter, quote } = inner();

    await new PerAccountQuoter(quoter).quote(request());

    expect(quote).toHaveBeenCalledTimes(1);
    expect(quote.mock.calls[0][0]).toEqual(request());
  });

  it("quotes a modality at its account's cubed weight", async () => {
    const { quoter, quote } = inner();
    const cubed = modality({ cubage: { factor: 3333, exemption: false, exemptionKg: 0 } });

    await new PerAccountQuoter(quoter).quote(request({ modalities: [cubed] }));

    expect(quote.mock.calls[0][0].weightKg).toBeCloseTo(6000 / 3333, 6);
  });

  it("keeps the real weight when the cubed one is within the exemption", async () => {
    const { quoter, quote } = inner();
    const exempt = modality({ cubage: { factor: 3333, exemption: true, exemptionKg: 5 } });

    await new PerAccountQuoter(quoter).quote(request({ modalities: [exempt] }));

    expect(quote.mock.calls[0][0].weightKg).toBe(0.3);
  });

  it("keeps the real weight when it is heavier than the cubed one", async () => {
    const { quoter, quote } = inner();
    const cubed = modality({ cubage: { factor: 6000, exemption: false, exemptionKg: 0 } });

    await new PerAccountQuoter(quoter).quote(request({ weightKg: 2, modalities: [cubed] }));

    expect(quote.mock.calls[0][0].weightKg).toBe(2);
  });

  // The v2 body carries one weight for every modality in it.
  it("asks once per distinct weight, each time only about the modalities at it", async () => {
    const air = modality({
      modalityId: 9,
      onlogModalityId: 402,
      cubage: { factor: 6000, exemption: false, exemptionKg: 0 },
    });
    const road = modality({ cubage: { factor: 3333, exemption: false, exemptionKg: 0 } });
    const loggi = modality({ carrierId: 12112, modalityId: 1, carrierConfigId: 3, onlogModalityId: 501 });
    const { quoter, quote } = inner((r) => r.modalities.map((m) => option({ modalityId: m.onlogModalityId })));

    const options = await new PerAccountQuoter(quoter).quote(request({ weightKg: 0.3, modalities: [air, road, loggi] }));

    const calls = quote.mock.calls.map(([r]) => [r.weightKg, r.modalities.map((m) => m.onlogModalityId)]);
    expect(calls).toHaveLength(3);
    expect(calls).toContainEqual([1, [402]]);
    expect(calls).toContainEqual([6000 / 3333, [401]]);
    expect(calls).toContainEqual([0.3, [501]]);
    expect(options.map((o) => o.modalityId).sort()).toEqual([401, 402, 501]);
  });

  it("passes the trace of the rows along to every request", async () => {
    const { quoter, quote } = inner();

    await new PerAccountQuoter(quoter).quote(request(), { sheetId: "abc", rows: [2, 3] });

    expect(quote.mock.calls[0][1]).toEqual({ sheetId: "abc", rows: [2, 3] });
  });
});

// The v1 route adds the account's extra cost to the carrier's cost before the
// margin (rnCotacao.js, GeraRetornoPrecoJadlog); the v2 route does not.
describe("PerAccountQuoter — account extra cost", () => {
  it("adds a fixed extra cost to the cost and, through the margin, to the price", async () => {
    const { quoter } = inner(() => [option()]);

    const [quoted] = await new PerAccountQuoter(quoter).quote(
      request({ modalities: [modality({ extraCost: 2, extraCostPct: 0 })] }),
    );

    // (6.14 + 2) × 2.05 = 16.687 — what production shows for this account.
    expect(quoted).toMatchObject({
      cost: 8.14,
      costWithoutExtras: 8.14,
      priceWithoutExtras: 16.69,
      finalPrice: 16.69,
      fullPrice: 16.69,
      additionalInfo: "{valorAdicContrato:2}",
    });
  });

  it("takes a percentage of the carrier's total when there is no fixed extra cost", async () => {
    const { quoter } = inner(() => [
      option({ cost: 10, costWithoutExtras: 10, priceWithoutExtras: 20.5, finalPrice: 20.5, fullPrice: 20.5 }),
    ]);

    const [quoted] = await new PerAccountQuoter(quoter).quote(
      request({ modalities: [modality({ extraCost: 0, extraCostPct: 10 })] }),
    );

    expect(quoted).toMatchObject({
      cost: 11,
      costWithoutExtras: 11,
      finalPrice: 22.55,
      additionalInfo: "{valorAdicContrato:1,percAdicContrato:10}",
    });
  });

  it("puts the extra cost through the margin discount and the final-price terms", async () => {
    const { quoter } = inner(() => [option({ priceWithoutExtras: 10, finalPrice: 11, fullPrice: 11 })]);
    const discounted = modality({
      profitMargin: 100,
      marginDiscountPct: 50,
      finalPriceDiscountPct: 10,
      finalPriceSurchargePct: 20,
      extraCost: 2,
    });

    const [quoted] = await new PerAccountQuoter(quoter).quote(request({ modalities: [discounted] }));

    // 2 × 1.5 (margin 100 halved) × 0.9 = 2.70 before the final-price extra; × 1.2 = 3.24 after.
    expect(quoted.priceWithoutExtras).toBe(12.7);
    expect(quoted.finalPrice).toBe(14.24);
  });

  it("leaves an option alone when its account has no extra cost", async () => {
    const { quoter } = inner(() => [option()]);

    const [quoted] = await new PerAccountQuoter(quoter).quote(request());

    expect(quoted).toEqual(option());
  });
});

// Best-account quoting: the log sends the modality once per account, and the
// cheapest cost after the extra cost wins (MinBy over custo + adicional in v1).
describe("PerAccountQuoter — best account", () => {
  it("keeps only the cheapest account of each modality", async () => {
    const accountA = modality({ carrierConfigId: 127, extraCost: 2 });
    const accountB = modality({ carrierConfigId: 200, extraCost: 0 });
    const { quoter } = inner(() => [
      // Cheaper before the extra cost, dearer after it: 7 + 2 = 9 against 8.5.
      option({ carrierConfigId: 127, cost: 7, costWithoutExtras: 7, finalPrice: 14.35 }),
      option({ carrierConfigId: 200, cost: 8.5, costWithoutExtras: 8.5, finalPrice: 17.43 }),
    ]);

    const options = await new PerAccountQuoter(quoter).quote(request({ modalities: [accountA, accountB] }));

    expect(options.map((o) => [o.carrierConfigId, o.costWithoutExtras])).toEqual([[200, 8.5]]);
  });

  it("keeps different modalities of the same carrier side by side", async () => {
    const { quoter } = inner(() => [option({ modalityId: 401 }), option({ modalityId: 402 })]);

    const options = await new PerAccountQuoter(quoter).quote(
      request({ modalities: [modality(), modality({ modalityId: 9, onlogModalityId: 402 })] }),
    );

    expect(options.map((o) => o.modalityId)).toEqual([401, 402]);
  });
});
