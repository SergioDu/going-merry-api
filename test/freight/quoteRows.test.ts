import { describe, expect, it, vi } from "vitest";

import { quoteRows } from "../../src/freight/quoteRows";
import { FreightOption, QuoteModality, QuoteRequest, Quoter } from "../../src/freight/freight";
import { SheetRow } from "../../src/sheet/row";
import { captureLogs } from "../logs";

function row(overrides: Partial<SheetRow> = {}): SheetRow {
  return {
    line: 2,
    recipient: {
      name: "MARIA",
      streetType: "RUA",
      street: "DAS FLORES",
      number: "10",
      complement: "",
      district: "CENTRO",
      city: "SAO PAULO",
      state: "SP",
      postalCode: "01001-000",
      taxId: "529.982.247-25",
      stateRegistration: "",
      phone: "(11) 99999-8888",
      email: "",
    },
    parcel: { weightKg: 1, heightCm: 10, widthCm: 20, lengthCm: 30, diameterCm: 0 },
    goodsValue: 100,
    declaredValue: 0,
    invoiceNumber: "",
    invoiceAccessKey: "",
    withDeliveryReceipt: false,
    senderReference: "",
    errors: [],
    ...overrides,
  };
}

function option(overrides: Partial<FreightOption> = {}): FreightOption {
  return {
    carrierId: 1,
    modalityId: 10,
    carrierConfigId: null,
    modalityName: "SEDEX",
    carrierLogo: "",
    deliveryDays: 3,
    deliveryTimeText: "3 dias úteis",
    finalPrice: 25.9,
    fullPrice: 25.9,
    cost: 18,
    costWithoutExtras: 18,
    priceWithoutExtras: 25.9,
    insuranceCost: 0,
    insurancePrice: 0,
    deliveryReceiptCost: 0,
    deliveryReceiptPrice: 0,
    closesPlp: 1,
    additionalInfo: "",
    ...overrides,
  };
}

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
    logo: "",
    extraDeliveryDays: 0,
    closesPlp: 1,
    maxWeightKg: 0,
    maxSideCm: 0,
    maxDimensionsSumCm: 0,
    ...overrides,
  };
}

const CONTEXT = { originPostalCode: "04571-010", modalities: [modality()] };

describe("quoteRows", () => {
  it("quotes each row and attaches the options to it", async () => {
    const quote = vi.fn<Quoter["quote"]>().mockResolvedValue([option()]);

    const { rows: quoted } = await quoteRows([row(), row({ line: 3 })], CONTEXT, { quote });

    expect(quoted).toHaveLength(2);
    expect(quoted[0].options).toHaveLength(1);
    expect(quoted[0].options[0].modalityName).toBe("SEDEX");
  });

  it("builds the quote request from the row and the sheet's context", async () => {
    const quote = vi.fn<Quoter["quote"]>().mockResolvedValue([option()]);

    await quoteRows([row({ declaredValue: 60, withDeliveryReceipt: true })], CONTEXT, { quote });

    const request: QuoteRequest = quote.mock.calls[0][0];
    expect(request).toEqual({
      originPostalCode: "04571-010",
      destinationPostalCode: "01001-000",
      weightKg: 1,
      heightCm: 10,
      widthCm: 20,
      lengthCm: 30,
      declaredValue: 60,
      withDeliveryReceipt: true,
      modalities: [modality()],
    });
  });

  // This is where the speed comes from on a real sheet: a thousand rows of the
  // same product going to a handful of cities are a handful of distinct quotes.
  it("quotes identical rows once and reuses the result", async () => {
    const quote = vi.fn<Quoter["quote"]>().mockResolvedValue([option()]);
    const identical = [row(), row({ line: 3 }), row({ line: 4 })];

    const { rows: quoted } = await quoteRows(identical, CONTEXT, { quote });

    expect(quote).toHaveBeenCalledTimes(1);
    expect(quoted.every((q) => q.options.length === 1)).toBe(true);
  });

  // The number that says whether the dedupe is doing anything on a real sheet —
  // it is what to look at first when an import is slow.
  it("reports how many distinct quotes it actually made", async () => {
    const quote = vi.fn<Quoter["quote"]>().mockResolvedValue([option()]);

    const { quoteCount } = await quoteRows(
      [row(), row({ line: 3 }), row({ line: 4, declaredValue: 60 })],
      CONTEXT,
      { quote },
    );

    expect(quoteCount).toBe(2);
  });

  it("counts no quotes when every row failed validation", async () => {
    const quote = vi.fn<Quoter["quote"]>().mockResolvedValue([option()]);

    const { quoteCount } = await quoteRows([row({ errors: ["CEP do destinatário inválido"] })], CONTEXT, { quote });

    expect(quoteCount).toBe(0);
  });

  it("does not reuse a quote across rows that differ in anything priced", async () => {
    const quote = vi.fn<Quoter["quote"]>().mockResolvedValue([option()]);

    await quoteRows(
      [
        row(),
        row({ parcel: { weightKg: 2, heightCm: 10, widthCm: 20, lengthCm: 30, diameterCm: 0 } }),
        row({ recipient: { ...row().recipient, postalCode: "20040-020" } }),
        row({ declaredValue: 60 }),
        row({ withDeliveryReceipt: true }),
      ],
      CONTEXT,
      { quote },
    );

    expect(quote).toHaveBeenCalledTimes(5);
  });

  it("sorts the options cheapest first, which is the one the log preselects", async () => {
    const quote = vi
      .fn<Quoter["quote"]>()
      .mockResolvedValue([option({ finalPrice: 40, modalityName: "SEDEX" }), option({ finalPrice: 22, modalityName: "PAC" })]);

    const { rows: quoted } = await quoteRows([row()], CONTEXT, { quote });

    expect(quoted[0].options.map((o) => o.modalityName)).toEqual(["PAC", "SEDEX"]);
  });

  it("never quotes a row that already failed validation", async () => {
    const quote = vi.fn<Quoter["quote"]>().mockResolvedValue([option()]);

    const { rows: quoted } = await quoteRows([row({ errors: ["CEP do destinatário inválido"] })], CONTEXT, { quote });

    expect(quote).not.toHaveBeenCalled();
    expect(quoted[0].options).toEqual([]);
  });

  it("reports a row with no available modality instead of dropping it", async () => {
    const quote = vi.fn<Quoter["quote"]>().mockResolvedValue([]);

    const { rows: quoted } = await quoteRows([row()], CONTEXT, { quote });

    expect(quoted[0].options).toEqual([]);
    expect(quoted[0].errors).toContain("Nenhuma modalidade compatível");
  });

  // One carrier timing out must not throw away the other 999 rows of the import.
  it("isolates a failed quote to its own row and keeps going", async () => {
    const quote = vi
      .fn<Quoter["quote"]>()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue([option()]);

    const { rows: quoted } = await quoteRows([row(), row({ line: 3, declaredValue: 60 })], CONTEXT, { quote });

    expect(quoted[0].options).toEqual([]);
    expect(quoted[0].errors).toContain("Não foi possível cotar o frete desta linha");
    expect(quoted[1].options).toHaveLength(1);
  });

  // The modality's registered limits depend only on the package, so they are
  // settled before asking: a modality that cannot carry it is not even quoted.
  it("only asks about the modalities that can carry the row's package", async () => {
    const quote = vi.fn<Quoter["quote"]>().mockResolvedValue([option()]);
    const context = {
      ...CONTEXT,
      modalities: [modality({ onlogModalityId: 301 }), modality({ onlogModalityId: 302, maxWeightKg: 0.5 })],
    };

    await quoteRows([row()], context, { quote });

    expect(quote.mock.calls[0][0].modalities.map((m) => m.onlogModalityId)).toEqual([301]);
  });

  it("does not quote a row no modality can carry, and says so", async () => {
    const quote = vi.fn<Quoter["quote"]>().mockResolvedValue([option()]);
    const context = { ...CONTEXT, modalities: [modality({ maxWeightKg: 0.5 })] };

    const { rows: quoted, quoteCount } = await quoteRows([row()], context, { quote });

    expect(quote).not.toHaveBeenCalled();
    expect(quoteCount).toBe(0);
    expect(quoted[0].errors).toContain("Nenhuma modalidade compatível");
  });

  it("keeps at most the configured number of quotes in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const quote = vi.fn<Quoter["quote"]>().mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return [option()];
    });

    // 20 rows that are all different, so none of them is served by the dedupe.
    const rows = Array.from({ length: 20 }, (_, i) => row({ line: i + 2, declaredValue: i + 1 }));

    await quoteRows(rows, CONTEXT, { quote }, 4);

    expect(quote).toHaveBeenCalledTimes(20);
    expect(peak).toBeLessThanOrEqual(4);
  });

  // Transfer-group modalities are filtered per row based on origin×destination,
  // so two rows with different destinations can get different modalities from the
  // same global list without mutating it.
  it("filters transfer-group modalities per row independently", async () => {
    const quote = vi.fn<Quoter["quote"]>().mockResolvedValue([option()]);

    const mpModality = modality({
      carrierId: 132226,
      onlogModalityId: 456,
      name: "Fastpack MP",
      transferGroup: 12,
      transferGroupPriority: 1,
      coverageRanges: [{ originStart: 4000000, originEnd: 4999999, destStart: 1000000, destEnd: 1999999 }],
    });

    const commonModality = modality({
      carrierId: 132226,
      onlogModalityId: 789,
      name: "Fastpack",
      transferGroup: 12,
      transferGroupPriority: 2,
      coverageRanges: [{ originStart: 4000000, originEnd: 4999999, destStart: 1000000, destEnd: 9999999 }],
    });

    const context = { originPostalCode: "04571-010", modalities: [mpModality, commonModality] };

    // Row A: destination covered by both → MP wins.
    // Row B: destination covered only by common → common wins.
    await quoteRows(
      [
        row({ line: 2, recipient: { ...row().recipient, postalCode: "01001-000" } }),
        row({ line: 3, recipient: { ...row().recipient, postalCode: "05001-000" } }),
      ],
      context,
      { quote },
    );

    expect(quote).toHaveBeenCalledTimes(2);
    // Row A gets only MP (priority 1).
    expect(quote.mock.calls[0][0].modalities.map((m: QuoteModality) => m.onlogModalityId)).toEqual([456]);
    // Row B gets only common (MP's coverage doesn't include 05xxxxx destination).
    expect(quote.mock.calls[1][0].modalities.map((m: QuoteModality) => m.onlogModalityId)).toEqual([789]);
  });

  it("keeps the rows in the sheet's order however the quotes resolve", async () => {
    const quote = vi.fn<Quoter["quote"]>().mockImplementation(async (request: QuoteRequest) => {
      // The later rows answer first.
      await new Promise((resolve) => setTimeout(resolve, 20 - request.declaredValue));
      return [option()];
    });

    const rows = Array.from({ length: 5 }, (_, i) => row({ line: i + 2, declaredValue: i + 1 }));

    const { rows: quoted } = await quoteRows(rows, CONTEXT, { quote }, 5);

    expect(quoted.map((q) => q.line)).toEqual([2, 3, 4, 5, 6]);
  });
});

// A quote serves every identical row of the sheet, so what ties a logged request
// back to the spreadsheet is the sheet's id and the rows that shared it.
describe("quoteRows tracing", () => {
  const logs = captureLogs();
  const context = { ...CONTEXT, sheetId: "abc123" };

  it("tells the quoter which sheet and which rows each quote serves", async () => {
    const quote = vi.fn<Quoter["quote"]>().mockResolvedValue([option()]);

    await quoteRows([row(), row({ line: 3 }), row({ line: 4, declaredValue: 60 })], context, { quote });

    expect(quote.mock.calls.map((call) => call[1])).toEqual([
      { sheetId: "abc123", rows: [2, 3] },
      { sheetId: "abc123", rows: [4] },
    ]);
  });

  it("logs the rows no modality can carry, since they never reach the API", async () => {
    const quote = vi.fn<Quoter["quote"]>().mockResolvedValue([option()]);

    await quoteRows([row(), row({ line: 3 })], { ...context, modalities: [modality({ maxWeightKg: 0.5 })] }, { quote });

    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: "[planilha] linhas sem modalidade para o pacote",
        sheetId: "abc123",
        rows: [2, 3],
        parcel: { weightKg: 1, heightCm: 10, widthCm: 20, lengthCm: 30 },
      }),
    );
  });
});
