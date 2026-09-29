import { describe, expect, it, vi } from "vitest";

import { CotadorPorConta } from "../../src/frete/cotadorPorConta";
import { Cotador, ModalidadeCotacao, OpcaoFrete, PedidoCotacao } from "../../src/frete/frete";

function modalidade(sobrescreve: Partial<ModalidadeCotacao> = {}): ModalidadeCotacao {
  return {
    idOperador: 14,
    idModalidade: 3,
    idCoreOperadorConfig: 127,
    idTabelaCusto: 0,
    idTabelaVenda: 0,
    margemLucro: 105,
    descPercVlFinal: 0,
    descPercMargem: 0,
    descValorFixo: 0,
    adicionalPercVlFinal: 0,
    adicionalValorFixoVlFinal: 0,
    idModalidadeOnlog: 401,
    descricao: "PACKAGE",
    logo: "",
    prazoAdicional: 0,
    fechaPlp: 1,
    pesoMaximo: 0,
    medidaMaximaPorLado: 0,
    medidaMaxima: 0,
    ...sobrescreve,
  };
}

// 10 × 20 × 30 = 6000 cm³: 1 kg at factor 6000, 1.8 kg at factor 3333.
function pedido(sobrescreve: Partial<PedidoCotacao> = {}): PedidoCotacao {
  return {
    cepOrigem: "01523-000",
    cepDestino: "01523-000",
    pesoKg: 0.3,
    alturaCm: 10,
    larguraCm: 20,
    comprimentoCm: 30,
    valorDeclarado: 0,
    comAr: false,
    modalidades: [modalidade()],
    ...sobrescreve,
  };
}

function opcao(sobrescreve: Partial<OpcaoFrete> = {}): OpcaoFrete {
  return {
    idOperador: 14,
    idModalidade: 401,
    idOperadorConfig: 127,
    descricaoModalidade: "PACKAGE",
    logoOperador: "",
    prazo: 2,
    prazoDias: "ENTREGA EM 2 DIAS ÚTEIS",
    valorFinal: 12.59,
    valorFinalCheio: 12.59,
    valorOriginal: 6.14,
    valorCustoSemAdic: 6.14,
    valorVendaSemAdic: 12.59,
    valorSeguroContrato: 0,
    valorSeguroVenda: 0,
    valorArContrato: 0,
    valorArVenda: 0,
    fechaPlp: 1,
    informacaoAdicional: "",
    ...sobrescreve,
  };
}

function interno(responde: (pedido: PedidoCotacao) => OpcaoFrete[] = () => []) {
  const cotar = vi.fn(async (pedido: PedidoCotacao) => responde(pedido));
  return { cotador: { cotar } as Cotador, cotar };
}

describe("CotadorPorConta — cubage", () => {
  it("quotes at the real weight when no modality has cubage parameters", async () => {
    const { cotador, cotar } = interno();

    await new CotadorPorConta(cotador).cotar(pedido());

    expect(cotar).toHaveBeenCalledTimes(1);
    expect(cotar.mock.calls[0][0]).toEqual(pedido());
  });

  it("quotes a modality at its account's cubed weight", async () => {
    const { cotador, cotar } = interno();
    const cubada = modalidade({ cubagem: { fatorCubagem: 3333, isencaoCubagem: false, isencaoCubagemKg: 0 } });

    await new CotadorPorConta(cotador).cotar(pedido({ modalidades: [cubada] }));

    expect(cotar.mock.calls[0][0].pesoKg).toBeCloseTo(6000 / 3333, 6);
  });

  it("keeps the real weight when the cubed one is within the exemption", async () => {
    const { cotador, cotar } = interno();
    const isenta = modalidade({ cubagem: { fatorCubagem: 3333, isencaoCubagem: true, isencaoCubagemKg: 5 } });

    await new CotadorPorConta(cotador).cotar(pedido({ modalidades: [isenta] }));

    expect(cotar.mock.calls[0][0].pesoKg).toBe(0.3);
  });

  it("keeps the real weight when it is heavier than the cubed one", async () => {
    const { cotador, cotar } = interno();
    const cubada = modalidade({ cubagem: { fatorCubagem: 6000, isencaoCubagem: false, isencaoCubagemKg: 0 } });

    await new CotadorPorConta(cotador).cotar(pedido({ pesoKg: 2, modalidades: [cubada] }));

    expect(cotar.mock.calls[0][0].pesoKg).toBe(2);
  });

  // The v2 body carries one weight for every modality in it.
  it("asks once per distinct weight, each time only about the modalities at it", async () => {
    const aereo = modalidade({
      idModalidade: 9,
      idModalidadeOnlog: 402,
      cubagem: { fatorCubagem: 6000, isencaoCubagem: false, isencaoCubagemKg: 0 },
    });
    const rodoviario = modalidade({ cubagem: { fatorCubagem: 3333, isencaoCubagem: false, isencaoCubagemKg: 0 } });
    const loggi = modalidade({ idOperador: 12112, idModalidade: 1, idCoreOperadorConfig: 3, idModalidadeOnlog: 501 });
    const { cotador, cotar } = interno((p) => p.modalidades.map((m) => opcao({ idModalidade: m.idModalidadeOnlog })));

    const opcoes = await new CotadorPorConta(cotador).cotar(
      pedido({ pesoKg: 0.3, modalidades: [aereo, rodoviario, loggi] }),
    );

    const chamadas = cotar.mock.calls.map(([p]) => [p.pesoKg, p.modalidades.map((m) => m.idModalidadeOnlog)]);
    expect(chamadas).toHaveLength(3);
    expect(chamadas).toContainEqual([1, [402]]);
    expect(chamadas).toContainEqual([6000 / 3333, [401]]);
    expect(chamadas).toContainEqual([0.3, [501]]);
    expect(opcoes.map((o) => o.idModalidade).sort()).toEqual([401, 402, 501]);
  });

  it("passes the trace of the rows along to every request", async () => {
    const { cotador, cotar } = interno();

    await new CotadorPorConta(cotador).cotar(pedido(), { idPlanilha: "abc", linhas: [2, 3] });

    expect(cotar.mock.calls[0][1]).toEqual({ idPlanilha: "abc", linhas: [2, 3] });
  });
});

// The v1 route adds the account's extra cost to the carrier's cost before the
// margin (rnCotacao.js, GeraRetornoPrecoJadlog); the v2 route does not.
describe("CotadorPorConta — account extra cost", () => {
  it("adds a fixed extra cost to the cost and, through the margin, to the price", async () => {
    const { cotador } = interno(() => [opcao()]);

    const [cotada] = await new CotadorPorConta(cotador).cotar(
      pedido({ modalidades: [modalidade({ adicionalCusto: 2, adicionalCustoPerc: 0 })] }),
    );

    // (6.14 + 2) × 2.05 = 16.687 — what production shows for this account.
    expect(cotada).toMatchObject({
      valorOriginal: 8.14,
      valorCustoSemAdic: 8.14,
      valorVendaSemAdic: 16.69,
      valorFinal: 16.69,
      valorFinalCheio: 16.69,
      informacaoAdicional: "{valorAdicContrato:2}",
    });
  });

  it("takes a percentage of the carrier's total when there is no fixed extra cost", async () => {
    const { cotador } = interno(() => [
      opcao({ valorOriginal: 10, valorCustoSemAdic: 10, valorVendaSemAdic: 20.5, valorFinal: 20.5, valorFinalCheio: 20.5 }),
    ]);

    const [cotada] = await new CotadorPorConta(cotador).cotar(
      pedido({ modalidades: [modalidade({ adicionalCusto: 0, adicionalCustoPerc: 10 })] }),
    );

    expect(cotada).toMatchObject({
      valorOriginal: 11,
      valorCustoSemAdic: 11,
      valorFinal: 22.55,
      informacaoAdicional: "{valorAdicContrato:1,percAdicContrato:10}",
    });
  });

  it("puts the extra cost through the margin discount and the final-price terms", async () => {
    const { cotador } = interno(() => [opcao({ valorVendaSemAdic: 10, valorFinal: 11, valorFinalCheio: 11 })]);
    const comDescontos = modalidade({
      margemLucro: 100,
      descPercMargem: 50,
      descPercVlFinal: 10,
      adicionalPercVlFinal: 20,
      adicionalCusto: 2,
    });

    const [cotada] = await new CotadorPorConta(cotador).cotar(pedido({ modalidades: [comDescontos] }));

    // 2 × 1.5 (margin 100 halved) × 0.9 = 2.70 before the final-price extra; × 1.2 = 3.24 after.
    expect(cotada.valorVendaSemAdic).toBe(12.7);
    expect(cotada.valorFinal).toBe(14.24);
  });

  it("leaves an option alone when its account has no extra cost", async () => {
    const { cotador } = interno(() => [opcao()]);

    const [cotada] = await new CotadorPorConta(cotador).cotar(pedido());

    expect(cotada).toEqual(opcao());
  });
});

// Best-account quoting: the log sends the modality once per account, and the
// cheapest cost after the extra cost wins (MinBy over custo + adicional in v1).
describe("CotadorPorConta — best account", () => {
  it("keeps only the cheapest account of each modality", async () => {
    const contaA = modalidade({ idCoreOperadorConfig: 127, adicionalCusto: 2 });
    const contaB = modalidade({ idCoreOperadorConfig: 200, adicionalCusto: 0 });
    const { cotador } = interno(() => [
      // Cheaper before the extra cost, dearer after it: 7 + 2 = 9 against 8.5.
      opcao({ idOperadorConfig: 127, valorOriginal: 7, valorCustoSemAdic: 7, valorFinal: 14.35 }),
      opcao({ idOperadorConfig: 200, valorOriginal: 8.5, valorCustoSemAdic: 8.5, valorFinal: 17.43 }),
    ]);

    const opcoes = await new CotadorPorConta(cotador).cotar(pedido({ modalidades: [contaA, contaB] }));

    expect(opcoes.map((o) => [o.idOperadorConfig, o.valorCustoSemAdic])).toEqual([[200, 8.5]]);
  });

  it("keeps different modalities of the same operator side by side", async () => {
    const { cotador } = interno(() => [opcao({ idModalidade: 401 }), opcao({ idModalidade: 402 })]);

    const opcoes = await new CotadorPorConta(cotador).cotar(
      pedido({ modalidades: [modalidade(), modalidade({ idModalidade: 9, idModalidadeOnlog: 402 })] }),
    );

    expect(opcoes.map((o) => o.idModalidade)).toEqual([401, 402]);
  });
});
