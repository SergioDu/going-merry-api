import { describe, expect, it, vi } from "vitest";

import { CotadorHttp } from "../../src/frete/cotadorHttp";
import { ModalidadeCotacao, PedidoCotacao } from "../../src/frete/frete";
import { capturarLogs } from "../logs";

const URL = "http://localhost:5105/api/v2/cotacao/valores/v2";

function modalidade(sobrescreve: Partial<ModalidadeCotacao> = {}): ModalidadeCotacao {
  return {
    idOperador: 13,
    idModalidade: 3,
    idCoreOperadorConfig: 0,
    idTabelaCusto: 1,
    idTabelaVenda: 2,
    margemLucro: 20,
    descPercVlFinal: 0,
    descPercMargem: 0,
    descValorFixo: 0,
    adicionalPercVlFinal: 0,
    adicionalValorFixoVlFinal: 0,
    idModalidadeOnlog: 301,
    descricao: "SEDEX",
    logo: "assets/img/logo_fornecedores/correios.png",
    prazoAdicional: 0,
    fechaPlp: 1,
    pesoMaximo: 0,
    medidaMaximaPorLado: 0,
    medidaMaxima: 0,
    ...sobrescreve,
  };
}

function pedido(sobrescreve: Partial<PedidoCotacao> = {}): PedidoCotacao {
  return {
    cepOrigem: "01001-000",
    cepDestino: "30140-071",
    pesoKg: 2.5,
    alturaCm: 10,
    larguraCm: 20,
    comprimentoCm: 30,
    valorDeclarado: 150,
    comAr: false,
    modalidades: [modalidade()],
    ...sobrescreve,
  };
}

// One modality as POST /api/v2/cotacao/valores/v2 reports it
// (Conecta.Api.Price, mdModalidadeRetorno serialized in camelCase).
function cotada(sobrescreve: Record<string, unknown> = {}) {
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
    ...sobrescreve,
  };
}

// The response groups the quoted modalities by operator.
function resposta(operadores: { operador: number; modalidades: unknown[] }[]) {
  return { data: { status: 200, valores: { operadores } } };
}

function cotadorCom(post: ReturnType<typeof vi.fn>, apiKey?: string) {
  return new CotadorHttp(URL, { http: { post } as never, apiKey });
}

describe("CotadorHttp", () => {
  it("posts one quote to the configured freight endpoint", async () => {
    const post = vi.fn().mockResolvedValue(resposta([{ operador: 13, modalidades: [cotada()] }]));

    await cotadorCom(post).cotar(pedido());

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe(URL);
  });

  it("sends the package, the route and the client's modalities in the v2 body", async () => {
    const post = vi.fn().mockResolvedValue(resposta([]));

    await cotadorCom(post).cotar(pedido());

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
    const post = vi.fn().mockResolvedValue(resposta([]));

    await cotadorCom(post).cotar(pedido({ comAr: true }));

    expect(post.mock.calls[0][1].possuiAvisoRecebimento).toBe(1);
  });

  it("sends the API key when one is configured", async () => {
    const post = vi.fn().mockResolvedValue(resposta([]));

    await cotadorCom(post, "conecta-dev-key").cotar(pedido());

    expect(post.mock.calls[0][2].headers["X-Api-Key"]).toBe("conecta-dev-key");
  });

  it("maps a quoted modality onto the freight option the log renders", async () => {
    const post = vi.fn().mockResolvedValue(
      resposta([{ operador: 13, modalidades: [cotada({ conta: 55, valorArcusto: 5, valorArVenda: 7 })] }]),
    );

    const opcoes = await cotadorCom(post).cotar(pedido({ modalidades: [modalidade({ prazoAdicional: 2 })] }));

    expect(opcoes).toEqual([
      {
        idOperador: 13,
        // The log's own modality id, which is what it writes to the temp table.
        idModalidade: 301,
        idOperadorConfig: 55,
        descricaoModalidade: "SEDEX",
        logoOperador: "assets/img/logo_fornecedores/correios.png",
        // The client's extra delivery days go on top of the carrier's.
        prazo: 5,
        prazoDias: "ENTREGA EM 5 DIAS ÚTEIS",
        valorFinal: 25.9,
        valorFinalCheio: 25.9,
        valorOriginal: 18,
        valorCustoSemAdic: 17,
        valorVendaSemAdic: 24.9,
        valorSeguroContrato: 1,
        valorSeguroVenda: 1,
        valorArContrato: 5,
        valorArVenda: 7,
        fechaPlp: 1,
        informacaoAdicional: "",
      },
    ]);
  });

  it("finds each quote's modality by operator and modality id", async () => {
    const post = vi.fn().mockResolvedValue(
      resposta([
        { operador: 14, modalidades: [cotada({ modalidadeId: 3, valorDeVenda: 30 })] },
        { operador: 13, modalidades: [cotada({ modalidadeId: 3, valorDeVenda: 20 })] },
      ]),
    );

    const opcoes = await cotadorCom(post).cotar(
      pedido({
        modalidades: [
          modalidade({ idOperador: 13, idModalidade: 3, idModalidadeOnlog: 301, descricao: "SEDEX" }),
          modalidade({ idOperador: 14, idModalidade: 3, idModalidadeOnlog: 401, descricao: "PACKAGE" }),
        ],
      }),
    );

    expect(opcoes.map((o) => [o.idOperador, o.idModalidade, o.descricaoModalidade, o.valorFinal])).toEqual([
      [14, 401, "PACKAGE", 30],
      [13, 301, "SEDEX", 20],
    ]);
  });

  it("uses the operator config the log sent when the API does not name the account", async () => {
    const post = vi.fn().mockResolvedValue(resposta([{ operador: 14, modalidades: [cotada({ conta: null })] }]));

    const [opcao] = await cotadorCom(post).cotar(
      pedido({ modalidades: [modalidade({ idOperador: 14, idCoreOperadorConfig: 88 })] }),
    );

    expect(opcao.idOperadorConfig).toBe(88);
  });

  it("keeps the carrier's extra information without quotes, like the log does", async () => {
    const post = vi.fn().mockResolvedValue(
      resposta([{ operador: 13, modalidades: [cotada({ adicionais: { cotacaoId: "abc" } })] }]),
    );

    const [opcao] = await cotadorCom(post).cotar(pedido());

    expect(opcao.informacaoAdicional).toBe("{cotacaoId:abc}");
  });

  it("says 1 DIA ÚTIL in the singular", async () => {
    const post = vi.fn().mockResolvedValue(resposta([{ operador: 13, modalidades: [cotada({ prazo: 1 })] }]));

    const [opcao] = await cotadorCom(post).cotar(pedido());

    expect(opcao.prazoDias).toBe("ENTREGA EM 1 DIA ÚTIL");
  });

  it("leaves out a modality the API could not quote", async () => {
    const post = vi.fn().mockResolvedValue(
      resposta([
        {
          operador: 13,
          modalidades: [
            cotada({ success: false, message: ["Precificação não encontrada"], valorDeVenda: 0, valorDeCusto: 0 }),
          ],
        },
      ]),
    );

    expect(await cotadorCom(post).cotar(pedido())).toEqual([]);
  });

  it("leaves out a quote without a usable price", async () => {
    const post = vi.fn().mockResolvedValue(
      resposta([{ operador: 13, modalidades: [cotada({ valorDeVenda: 0 }), cotada({ valorDeCusto: 0 })] }]),
    );

    expect(await cotadorCom(post).cotar(pedido())).toEqual([]);
  });

  it("ignores a quote for a modality it did not ask about", async () => {
    const post = vi.fn().mockResolvedValue(resposta([{ operador: 13, modalidades: [cotada({ modalidadeId: 99 })] }]));

    expect(await cotadorCom(post).cotar(pedido())).toEqual([]);
  });

  it("treats a response with no operators as a package nobody can carry", async () => {
    const post = vi.fn().mockResolvedValue({ data: {} });

    expect(await cotadorCom(post).cotar(pedido())).toEqual([]);
  });

  it("lets a transport failure through so the caller can fail just that row", async () => {
    const post = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(cotadorCom(post).cotar(pedido())).rejects.toThrow();
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

    const [opcao] = await cotadorCom(post).cotar(pedido());

    expect(opcao).toMatchObject({
      idOperadorConfig: 55,
      prazo: 3,
      valorFinal: 25.9,
      valorOriginal: 18,
      valorCustoSemAdic: 17,
      valorVendaSemAdic: 24.9,
      valorSeguroContrato: 1,
      valorArContrato: 5,
      valorArVenda: 7,
    });
  });

  // OnlogRed is priced by the same tables as Correios, and the v2 route only
  // routes it as Correios. It goes out as 13 and comes back as OnlogRed.
  it("asks the API under the operator it quotes by, and answers under the log's own", async () => {
    const post = vi.fn().mockResolvedValue(resposta([{ operador: 13, modalidades: [cotada({ modalidadeId: 4 })] }]));

    const opcoes = await cotadorCom(post).cotar(
      pedido({ modalidades: [modalidade({ idOperador: 132226, idOperadorCotacao: 13, idModalidade: 4 })] }),
    );

    expect(post.mock.calls[0][1].modalidades[0].idOperador).toBe(13);
    expect(opcoes.map((o) => o.idOperador)).toEqual([132226]);
  });

  // Best-account quoting sends the same modality once per account.
  it("tells apart the same modality quoted on two accounts by the account", async () => {
    const post = vi.fn().mockResolvedValue(
      resposta([
        {
          operador: 14,
          modalidades: [
            cotada({ modalidadeId: 3, conta: 200, valorDeVenda: 30 }),
            cotada({ modalidadeId: 3, conta: 127, valorDeVenda: 20 }),
          ],
        },
      ]),
    );

    const opcoes = await cotadorCom(post).cotar(
      pedido({
        modalidades: [
          modalidade({ idOperador: 14, idModalidade: 3, idCoreOperadorConfig: 127, prazoAdicional: 1 }),
          modalidade({ idOperador: 14, idModalidade: 3, idCoreOperadorConfig: 200, prazoAdicional: 0 }),
        ],
      }),
    );

    // Each answer takes its own entry's settings: the extra day is account 127's.
    expect(opcoes.map((o) => [o.idOperadorConfig, o.valorFinal, o.prazo])).toEqual([
      [200, 30, 3],
      [127, 20, 4],
    ]);
  });

  // A Correios SEDEX and an OnlogRed SEDEX both go out as operator 13 with the
  // same modality id; the API answers them in the order they were sent.
  it("pairs repeated modalities without an account in the order they were sent", async () => {
    const post = vi.fn().mockResolvedValue(
      resposta([
        {
          operador: 13,
          modalidades: [cotada({ modalidadeId: 4, valorDeVenda: 20 }), cotada({ modalidadeId: 4, valorDeVenda: 15 })],
        },
      ]),
    );

    const opcoes = await cotadorCom(post).cotar(
      pedido({
        modalidades: [
          modalidade({ idOperador: 13, idModalidade: 4, idModalidadeOnlog: 301 }),
          modalidade({ idOperador: 132226, idOperadorCotacao: 13, idModalidade: 4, idModalidadeOnlog: 901 }),
        ],
      }),
    );

    expect(opcoes.map((o) => [o.idOperador, o.idModalidade, o.valorFinal])).toEqual([
      [13, 301, 20],
      [132226, 901, 15],
    ]);
  });
});

// When a sheet comes back with every row un-quotable, the first question is
// whether the problem was in what went out or in what came back. The log keeps
// both, for every quote, tagged with the sheet and the rows it priced.
describe("CotadorHttp logs", () => {
  const logs = capturarLogs();
  const rastro = { idPlanilha: "abc123", linhas: [2, 5] };

  it("logs the body it sent and the API's answer, with the sheet and the rows the quote serves", async () => {
    const respondida = { ...resposta([{ operador: 13, modalidades: [cotada({ success: false, message: ["PRZ-008"] })] }]), status: 200 };
    const post = vi.fn().mockResolvedValue(respondida);

    await cotadorCom(post).cotar(pedido(), rastro);

    const log = logs.find((l) => l.msg === "[planilha] cotação");
    expect(log).toMatchObject({
      level: "info",
      idPlanilha: "abc123",
      linhas: [2, 5],
      url: URL,
      status: 200,
      requisicao: post.mock.calls[0][1],
      resposta: respondida.data,
    });
    expect(log?.tempoMs).toEqual(expect.any(Number));
  });

  it("logs what it sent and what the API answered when the quote fails, and still fails", async () => {
    const erro = Object.assign(new Error("Request failed with status code 500"), {
      response: { status: 500, data: { mensagem: "erro interno" } },
    });
    const post = vi.fn().mockRejectedValue(erro);

    await expect(cotadorCom(post).cotar(pedido(), rastro)).rejects.toThrow();

    expect(logs.find((l) => l.msg === "[planilha] cotação falhou")).toMatchObject({
      level: "error",
      idPlanilha: "abc123",
      linhas: [2, 5],
      status: 500,
      requisicao: post.mock.calls[0][1],
      resposta: { mensagem: "erro interno" },
      err: "Request failed with status code 500",
    });
  });

  it("logs a failure that never got an answer, such as a timeout", async () => {
    const post = vi.fn().mockRejectedValue(new Error("timeout of 15000ms exceeded"));

    await expect(cotadorCom(post).cotar(pedido(), rastro)).rejects.toThrow();

    const log = logs.find((l) => l.msg === "[planilha] cotação falhou");
    expect(log).toMatchObject({ err: "timeout of 15000ms exceeded", requisicao: post.mock.calls[0][1] });
    expect(log?.resposta).toBeUndefined();
  });
});
