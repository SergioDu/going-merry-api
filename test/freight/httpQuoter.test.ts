import { describe, expect, it, vi } from "vitest";

import { HttpQuoter } from "../../src/freight/httpQuoter";
import { QuoteModality, QuoteRequest } from "../../src/freight/freight";
import { captureLogs } from "../logs";

const URL = "http://localhost:5105/api/v2/cotacao/valores/v2";

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

function request(overrides: Partial<QuoteRequest> = {}): QuoteRequest {
  return {
    originPostalCode: "01001-000",
    destinationPostalCode: "30140-071",
    weightKg: 2.5,
    heightCm: 10,
    widthCm: 20,
    lengthCm: 30,
    declaredValue: 150,
    withDeliveryReceipt: false,
    modalities: [modality()],
    ...overrides,
  };
}

// One modality as POST /api/v2/cotacao/valores/v2 reports it
// (Conecta.Api.Price, mdModalidadeRetorno serialized in camelCase).
function quoted(overrides: Record<string, unknown> = {}) {
  return {
    modalidadeId: 3,
    valorDeCusto: 18,
    valorCustoSemAdicionais: 17,
    valorSeguroCusto: 1,
    valorArcusto: 0,
    valorDeVenda: 25.9,
    valorVendaSemAdicionais: 24.9,
    valorSeguroVenda: 1,
    valorArVenda: 0,
    prazo: 3,
    conta: null,
    success: true,
    message: null,
    adicionais: null,
    ...overrides,
  };
}

// The response groups the quoted modalities by carrier.
function response(operadores: { operador: number; modalidades: unknown[] }[]) {
  return { data: { status: 200, valores: { operadores } } };
}

function quoterWith(post: ReturnType<typeof vi.fn>, apiKey?: string) {
  return new HttpQuoter(URL, { http: { post } as never, apiKey });
}

describe("HttpQuoter", () => {
  it("posts one quote to the configured freight endpoint", async () => {
    const post = vi.fn().mockResolvedValue(response([{ operador: 13, modalidades: [quoted()] }]));

    await quoterWith(post).quote(request());

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe(URL);
  });

  it("sends the package, the route and the client's modalities in the v2 body", async () => {
    const post = vi.fn().mockResolvedValue(response([]));

    await quoterWith(post).quote(request());

    expect(post.mock.calls[0][1]).toEqual({
      // CEPs go as digits only.
      cepInicial: "01001000",
      cepFinal: "30140071",
      peso: 2.5,
      altura: 10,
      largura: 20,
      profundidade: 30,
      valorDeclarado: 150,
      possuiAvisoRecebimento: 0,
      usarCache: true,
      modalidades: [
        {
          idModalidade: 3,
          idOperador: 13,
          idCoreOperadorConfig: 0,
          idTabelaCusto: 1,
          idTabelaVenda: 2,
          margemLucro: 20,
          descPercVlFinal: 0,
          descPercMargem: 0,
          descValorFixo: 0,
          adicionalPercVlFinal: 0,
          adicionalValorFixoVlFinal: 0,
        },
      ],
    });
  });

  it("asks for the return receipt when the row wants one", async () => {
    const post = vi.fn().mockResolvedValue(response([]));

    await quoterWith(post).quote(request({ withDeliveryReceipt: true }));

    expect(post.mock.calls[0][1].possuiAvisoRecebimento).toBe(1);
  });

  it("sends the API key when one is configured", async () => {
    const post = vi.fn().mockResolvedValue(response([]));

    await quoterWith(post, "conecta-dev-key").quote(request());

    expect(post.mock.calls[0][2].headers["X-Api-Key"]).toBe("conecta-dev-key");
  });

  it("maps a quoted modality onto the freight option the log renders", async () => {
    const post = vi.fn().mockResolvedValue(
      response([{ operador: 13, modalidades: [quoted({ conta: 55, valorArcusto: 5, valorArVenda: 7 })] }]),
    );

    const options = await quoterWith(post).quote(request({ modalities: [modality({ extraDeliveryDays: 2 })] }));

    expect(options).toEqual([
      {
        carrierId: 13,
        // The log's own modality id, which is what it writes to the temp table.
        modalityId: 301,
        carrierConfigId: 55,
        modalityName: "SEDEX",
        carrierLogo: "assets/img/logo_fornecedores/correios.png",
        // The client's extra delivery days go on top of the carrier's.
        deliveryDays: 5,
        deliveryTimeText: "ENTREGA EM 5 DIAS ÚTEIS",
        finalPrice: 25.9,
        fullPrice: 25.9,
        cost: 18,
        costWithoutExtras: 17,
        priceWithoutExtras: 24.9,
        insuranceCost: 1,
        insurancePrice: 1,
        deliveryReceiptCost: 5,
        deliveryReceiptPrice: 7,
        closesPlp: 1,
        additionalInfo: "",
      },
    ]);
  });

  it("finds each quote's modality by carrier and modality id", async () => {
    const post = vi.fn().mockResolvedValue(
      response([
        { operador: 14, modalidades: [quoted({ modalidadeId: 3, valorDeVenda: 30 })] },
        { operador: 13, modalidades: [quoted({ modalidadeId: 3, valorDeVenda: 20 })] },
      ]),
    );

    const options = await quoterWith(post).quote(
      request({
        modalities: [
          modality({ carrierId: 13, modalityId: 3, onlogModalityId: 301, name: "SEDEX" }),
          modality({ carrierId: 14, modalityId: 3, onlogModalityId: 401, name: "PACKAGE" }),
        ],
      }),
    );

    expect(options.map((o) => [o.carrierId, o.modalityId, o.modalityName, o.finalPrice])).toEqual([
      [14, 401, "PACKAGE", 30],
      [13, 301, "SEDEX", 20],
    ]);
  });

  it("uses the carrier config the log sent when the API does not name the account", async () => {
    const post = vi.fn().mockResolvedValue(response([{ operador: 14, modalidades: [quoted({ conta: null })] }]));

    const [option] = await quoterWith(post).quote(
      request({ modalities: [modality({ carrierId: 14, carrierConfigId: 88 })] }),
    );

    expect(option.carrierConfigId).toBe(88);
  });

  it("keeps the carrier's extra information without quotes, like the log does", async () => {
    const post = vi.fn().mockResolvedValue(
      response([{ operador: 13, modalidades: [quoted({ adicionais: { cotacaoId: "abc" } })] }]),
    );

    const [option] = await quoterWith(post).quote(request());

    expect(option.additionalInfo).toBe("{cotacaoId:abc}");
  });

  it("says 1 DIA ÚTIL in the singular", async () => {
    const post = vi.fn().mockResolvedValue(response([{ operador: 13, modalidades: [quoted({ prazo: 1 })] }]));

    const [option] = await quoterWith(post).quote(request());

    expect(option.deliveryTimeText).toBe("ENTREGA EM 1 DIA ÚTIL");
  });

  it("leaves out a modality the API could not quote", async () => {
    const post = vi.fn().mockResolvedValue(
      response([
        {
          operador: 13,
          modalidades: [
            quoted({ success: false, message: ["Precificação não encontrada"], valorDeVenda: 0, valorDeCusto: 0 }),
          ],
        },
      ]),
    );

    expect(await quoterWith(post).quote(request())).toEqual([]);
  });

  it("leaves out a quote without a usable price", async () => {
    const post = vi.fn().mockResolvedValue(
      response([{ operador: 13, modalidades: [quoted({ valorDeVenda: 0 }), quoted({ valorDeCusto: 0 })] }]),
    );

    expect(await quoterWith(post).quote(request())).toEqual([]);
  });

  it("ignores a quote for a modality it did not ask about", async () => {
    const post = vi.fn().mockResolvedValue(response([{ operador: 13, modalidades: [quoted({ modalidadeId: 99 })] }]));

    expect(await quoterWith(post).quote(request())).toEqual([]);
  });

  it("treats a response with no carriers as a package nobody can carry", async () => {
    const post = vi.fn().mockResolvedValue({ data: {} });

    expect(await quoterWith(post).quote(request())).toEqual([]);
  });

  it("lets a transport failure through so the caller can fail just that row", async () => {
    const post = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(quoterWith(post).quote(request())).rejects.toThrow();
  });

  // The API's cache hands back what it stored, serialized with .NET's default
  // PascalCase, while a fresh answer comes in camelCase.
  it("reads a cached answer written in PascalCase", async () => {
    const post = vi.fn().mockResolvedValue({
      data: {
        status: 200,
        valores: {
          operadores: [
            {
              operador: 13,
              modalidades: [
                {
                  ModalidadeId: 3,
                  ValorDeCusto: 18,
                  ValorCustoSemAdicionais: 17,
                  ValorSeguroCusto: 1,
                  valorArcusto: 5,
                  ValorDeVenda: 25.9,
                  ValorVendaSemAdicionais: 24.9,
                  ValorSeguroVenda: 1,
                  ValorArVenda: 7,
                  Prazo: 3,
                  Conta: 55,
                  Success: true,
                },
              ],
            },
          ],
        },
      },
    });

    const [option] = await quoterWith(post).quote(request());

    expect(option).toMatchObject({
      carrierConfigId: 55,
      deliveryDays: 3,
      finalPrice: 25.9,
      cost: 18,
      costWithoutExtras: 17,
      priceWithoutExtras: 24.9,
      insuranceCost: 1,
      deliveryReceiptCost: 5,
      deliveryReceiptPrice: 7,
    });
  });

  // OnlogRed is priced by the same tables as Correios, and the v2 route only
  // routes it as Correios. It goes out as 13 and comes back as OnlogRed.
  it("asks the API under the carrier it quotes by, and answers under the log's own", async () => {
    const post = vi.fn().mockResolvedValue(response([{ operador: 13, modalidades: [quoted({ modalidadeId: 4 })] }]));

    const options = await quoterWith(post).quote(
      request({ modalities: [modality({ carrierId: 132226, quoteCarrierId: 13, modalityId: 4 })] }),
    );

    expect(post.mock.calls[0][1].modalidades[0].idOperador).toBe(13);
    expect(options.map((o) => o.carrierId)).toEqual([132226]);
  });

  // Best-account quoting sends the same modality once per account.
  it("tells apart the same modality quoted on two accounts by the account", async () => {
    const post = vi.fn().mockResolvedValue(
      response([
        {
          operador: 14,
          modalidades: [
            quoted({ modalidadeId: 3, conta: 200, valorDeVenda: 30 }),
            quoted({ modalidadeId: 3, conta: 127, valorDeVenda: 20 }),
          ],
        },
      ]),
    );

    const options = await quoterWith(post).quote(
      request({
        modalities: [
          modality({ carrierId: 14, modalityId: 3, carrierConfigId: 127, extraDeliveryDays: 1 }),
          modality({ carrierId: 14, modalityId: 3, carrierConfigId: 200, extraDeliveryDays: 0 }),
        ],
      }),
    );

    // Each answer takes its own entry's settings: the extra day is account 127's.
    expect(options.map((o) => [o.carrierConfigId, o.finalPrice, o.deliveryDays])).toEqual([
      [200, 30, 3],
      [127, 20, 4],
    ]);
  });

  // A Correios SEDEX and an OnlogRed SEDEX both go out as carrier 13 with the
  // same modality id; the API answers them in the order they were sent.
  it("pairs repeated modalities without an account in the order they were sent", async () => {
    const post = vi.fn().mockResolvedValue(
      response([
        {
          operador: 13,
          modalidades: [quoted({ modalidadeId: 4, valorDeVenda: 20 }), quoted({ modalidadeId: 4, valorDeVenda: 15 })],
        },
      ]),
    );

    const options = await quoterWith(post).quote(
      request({
        modalities: [
          modality({ carrierId: 13, modalityId: 4, onlogModalityId: 301 }),
          modality({ carrierId: 132226, quoteCarrierId: 13, modalityId: 4, onlogModalityId: 901 }),
        ],
      }),
    );

    expect(options.map((o) => [o.carrierId, o.modalityId, o.finalPrice])).toEqual([
      [13, 301, 20],
      [132226, 901, 15],
    ]);
  });
});

// When a sheet comes back with every row un-quotable, the first question is
// whether the problem was in what went out or in what came back. The log keeps
// both, for every quote, tagged with the sheet and the rows it priced.
describe("HttpQuoter logs", () => {
  const logs = captureLogs();
  const trace = { sheetId: "abc123", rows: [2, 5] };

  it("logs the body it sent and the API's answer, with the sheet and the rows the quote serves", async () => {
    const answered = { ...response([{ operador: 13, modalidades: [quoted({ success: false, message: ["PRZ-008"] })] }]), status: 200 };
    const post = vi.fn().mockResolvedValue(answered);

    await quoterWith(post).quote(request(), trace);

    const log = logs.find((l) => l.msg === "[planilha] cotação");
    expect(log).toMatchObject({
      level: "info",
      sheetId: "abc123",
      rows: [2, 5],
      url: URL,
      status: 200,
      request: post.mock.calls[0][1],
      response: answered.data,
    });
    expect(log?.durationMs).toEqual(expect.any(Number));
  });

  it("logs what it sent and what the API answered when the quote fails, and still fails", async () => {
    const error = Object.assign(new Error("Request failed with status code 500"), {
      response: { status: 500, data: { mensagem: "erro interno" } },
    });
    const post = vi.fn().mockRejectedValue(error);

    await expect(quoterWith(post).quote(request(), trace)).rejects.toThrow();

    expect(logs.find((l) => l.msg === "[planilha] cotação falhou")).toMatchObject({
      level: "error",
      sheetId: "abc123",
      rows: [2, 5],
      status: 500,
      request: post.mock.calls[0][1],
      response: { mensagem: "erro interno" },
      err: "Request failed with status code 500",
    });
  });

  it("logs a failure that never got an answer, such as a timeout", async () => {
    const post = vi.fn().mockRejectedValue(new Error("timeout of 15000ms exceeded"));

    await expect(quoterWith(post).quote(request(), trace)).rejects.toThrow();

    const log = logs.find((l) => l.msg === "[planilha] cotação falhou");
    expect(log).toMatchObject({ err: "timeout of 15000ms exceeded", request: post.mock.calls[0][1] });
    expect(log?.response).toBeUndefined();
  });
});
