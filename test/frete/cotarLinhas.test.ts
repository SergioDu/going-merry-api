import { describe, expect, it, vi } from "vitest";

import { cotarLinhas } from "../../src/frete/cotarLinhas";
import { Cotador, ModalidadeCotacao, OpcaoFrete, PedidoCotacao } from "../../src/frete/frete";
import { LinhaPlanilha } from "../../src/planilha/linha";
import { capturarLogs } from "../logs";

function linha(sobrescreve: Partial<LinhaPlanilha> = {}): LinhaPlanilha {
  return {
    linha: 2,
    destinatario: {
      nome: "MARIA",
      logradouro: "RUA",
      endereco: "DAS FLORES",
      numero: "10",
      complemento: "",
      bairro: "CENTRO",
      cidade: "SAO PAULO",
      uf: "SP",
      cep: "01001-000",
      cpfCnpj: "529.982.247-25",
      rgIe: "",
      telefone: "(11) 99999-8888",
      email: "",
    },
    objeto: { pesoKg: 1, alturaCm: 10, larguraCm: 20, comprimentoCm: 30, diametroCm: 0 },
    valorMercadoria: 100,
    valorDeclarado: 0,
    numeroNf: "",
    chaveAcessoNf: "",
    comAr: false,
    controleRemetente: "",
    erros: [],
    ...sobrescreve,
  };
}

function opcao(sobrescreve: Partial<OpcaoFrete> = {}): OpcaoFrete {
  return {
    idOperador: 1,
    idModalidade: 10,
    idOperadorConfig: null,
    descricaoModalidade: "SEDEX",
    logoOperador: "",
    prazo: 3,
    prazoDias: "3 dias úteis",
    valorFinal: 25.9,
    valorFinalCheio: 25.9,
    valorOriginal: 18,
    valorCustoSemAdic: 18,
    valorVendaSemAdic: 25.9,
    valorSeguroContrato: 0,
    valorSeguroVenda: 0,
    valorArContrato: 0,
    valorArVenda: 0,
    fechaPlp: 1,
    informacaoAdicional: "",
    ...sobrescreve,
  };
}

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
    logo: "",
    prazoAdicional: 0,
    fechaPlp: 1,
    pesoMaximo: 0,
    medidaMaximaPorLado: 0,
    medidaMaxima: 0,
    ...sobrescreve,
  };
}

const CONTEXTO = { cepOrigem: "04571-010", modalidades: [modalidade()] };

describe("cotarLinhas", () => {
  it("quotes each row and attaches the options to it", async () => {
    const cotar = vi.fn<Cotador["cotar"]>().mockResolvedValue([opcao()]);

    const { linhas: cotadas } = await cotarLinhas([linha(), linha({ linha: 3 })], CONTEXTO, { cotar });

    expect(cotadas).toHaveLength(2);
    expect(cotadas[0].opcoes).toHaveLength(1);
    expect(cotadas[0].opcoes[0].descricaoModalidade).toBe("SEDEX");
  });

  it("builds the quote request from the row and the sheet's context", async () => {
    const cotar = vi.fn<Cotador["cotar"]>().mockResolvedValue([opcao()]);

    await cotarLinhas([linha({ valorDeclarado: 60, comAr: true })], CONTEXTO, { cotar });

    const pedido: PedidoCotacao = cotar.mock.calls[0][0];
    expect(pedido).toEqual({
      cepOrigem: "04571-010",
      cepDestino: "01001-000",
      pesoKg: 1,
      alturaCm: 10,
      larguraCm: 20,
      comprimentoCm: 30,
      valorDeclarado: 60,
      comAr: true,
      modalidades: [modalidade()],
    });
  });

  // This is where the speed comes from on a real sheet: a thousand rows of the
  // same product going to a handful of cities are a handful of distinct quotes.
  it("quotes identical rows once and reuses the result", async () => {
    const cotar = vi.fn<Cotador["cotar"]>().mockResolvedValue([opcao()]);
    const iguais = [linha(), linha({ linha: 3 }), linha({ linha: 4 })];

    const { linhas: cotadas } = await cotarLinhas(iguais, CONTEXTO, { cotar });

    expect(cotar).toHaveBeenCalledTimes(1);
    expect(cotadas.every((c) => c.opcoes.length === 1)).toBe(true);
  });

  // The number that says whether the dedupe is doing anything on a real sheet —
  // it is what to look at first when an import is slow.
  it("reports how many distinct quotes it actually made", async () => {
    const cotar = vi.fn<Cotador["cotar"]>().mockResolvedValue([opcao()]);

    const { cotacoes } = await cotarLinhas(
      [linha(), linha({ linha: 3 }), linha({ linha: 4, valorDeclarado: 60 })],
      CONTEXTO,
      { cotar },
    );

    expect(cotacoes).toBe(2);
  });

  it("counts no quotes when every row failed validation", async () => {
    const cotar = vi.fn<Cotador["cotar"]>().mockResolvedValue([opcao()]);

    const { cotacoes } = await cotarLinhas([linha({ erros: ["CEP do destinatário inválido"] })], CONTEXTO, { cotar });

    expect(cotacoes).toBe(0);
  });

  it("does not reuse a quote across rows that differ in anything priced", async () => {
    const cotar = vi.fn<Cotador["cotar"]>().mockResolvedValue([opcao()]);

    await cotarLinhas(
      [
        linha(),
        linha({ objeto: { pesoKg: 2, alturaCm: 10, larguraCm: 20, comprimentoCm: 30, diametroCm: 0 } }),
        linha({ destinatario: { ...linha().destinatario, cep: "20040-020" } }),
        linha({ valorDeclarado: 60 }),
        linha({ comAr: true }),
      ],
      CONTEXTO,
      { cotar },
    );

    expect(cotar).toHaveBeenCalledTimes(5);
  });

  it("sorts the options cheapest first, which is the one the log preselects", async () => {
    const cotar = vi
      .fn<Cotador["cotar"]>()
      .mockResolvedValue([opcao({ valorFinal: 40, descricaoModalidade: "SEDEX" }), opcao({ valorFinal: 22, descricaoModalidade: "PAC" })]);

    const { linhas: cotadas } = await cotarLinhas([linha()], CONTEXTO, { cotar });

    expect(cotadas[0].opcoes.map((o) => o.descricaoModalidade)).toEqual(["PAC", "SEDEX"]);
  });

  it("never quotes a row that already failed validation", async () => {
    const cotar = vi.fn<Cotador["cotar"]>().mockResolvedValue([opcao()]);

    const { linhas: cotadas } = await cotarLinhas([linha({ erros: ["CEP do destinatário inválido"] })], CONTEXTO, { cotar });

    expect(cotar).not.toHaveBeenCalled();
    expect(cotadas[0].opcoes).toEqual([]);
  });

  it("reports a row with no available modality instead of dropping it", async () => {
    const cotar = vi.fn<Cotador["cotar"]>().mockResolvedValue([]);

    const { linhas: cotadas } = await cotarLinhas([linha()], CONTEXTO, { cotar });

    expect(cotadas[0].opcoes).toEqual([]);
    expect(cotadas[0].erros).toContain("Nenhuma modalidade compatível");
  });

  // One carrier timing out must not throw away the other 999 rows of the import.
  it("isolates a failed quote to its own row and keeps going", async () => {
    const cotar = vi
      .fn<Cotador["cotar"]>()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue([opcao()]);

    const { linhas: cotadas } = await cotarLinhas([linha(), linha({ linha: 3, valorDeclarado: 60 })], CONTEXTO, { cotar });

    expect(cotadas[0].opcoes).toEqual([]);
    expect(cotadas[0].erros).toContain("Não foi possível cotar o frete desta linha");
    expect(cotadas[1].opcoes).toHaveLength(1);
  });

  // The modality's registered limits depend only on the package, so they are
  // settled before asking: a modality that cannot carry it is not even quoted.
  it("only asks about the modalities that can carry the row's package", async () => {
    const cotar = vi.fn<Cotador["cotar"]>().mockResolvedValue([opcao()]);
    const contexto = {
      ...CONTEXTO,
      modalidades: [modalidade({ idModalidadeOnlog: 301 }), modalidade({ idModalidadeOnlog: 302, pesoMaximo: 0.5 })],
    };

    await cotarLinhas([linha()], contexto, { cotar });

    expect(cotar.mock.calls[0][0].modalidades.map((m) => m.idModalidadeOnlog)).toEqual([301]);
  });

  it("does not quote a row no modality can carry, and says so", async () => {
    const cotar = vi.fn<Cotador["cotar"]>().mockResolvedValue([opcao()]);
    const contexto = { ...CONTEXTO, modalidades: [modalidade({ pesoMaximo: 0.5 })] };

    const { linhas: cotadas, cotacoes } = await cotarLinhas([linha()], contexto, { cotar });

    expect(cotar).not.toHaveBeenCalled();
    expect(cotacoes).toBe(0);
    expect(cotadas[0].erros).toContain("Nenhuma modalidade compatível");
  });

  it("keeps at most the configured number of quotes in flight", async () => {
    let emVoo = 0;
    let pico = 0;
    const cotar = vi.fn<Cotador["cotar"]>().mockImplementation(async () => {
      emVoo++;
      pico = Math.max(pico, emVoo);
      await new Promise((resolve) => setTimeout(resolve, 5));
      emVoo--;
      return [opcao()];
    });

    // 20 rows that are all different, so none of them is served by the dedupe.
    const linhas = Array.from({ length: 20 }, (_, i) => linha({ linha: i + 2, valorDeclarado: i + 1 }));

    await cotarLinhas(linhas, CONTEXTO, { cotar }, 4);

    expect(cotar).toHaveBeenCalledTimes(20);
    expect(pico).toBeLessThanOrEqual(4);
  });

  it("keeps the rows in the sheet's order however the quotes resolve", async () => {
    const cotar = vi.fn<Cotador["cotar"]>().mockImplementation(async (pedido: PedidoCotacao) => {
      // The later rows answer first.
      await new Promise((resolve) => setTimeout(resolve, 20 - pedido.valorDeclarado));
      return [opcao()];
    });

    const linhas = Array.from({ length: 5 }, (_, i) => linha({ linha: i + 2, valorDeclarado: i + 1 }));

    const { linhas: cotadas } = await cotarLinhas(linhas, CONTEXTO, { cotar }, 5);

    expect(cotadas.map((c) => c.linha)).toEqual([2, 3, 4, 5, 6]);
  });
});

// A quote serves every identical row of the sheet, so what ties a logged request
// back to the spreadsheet is the sheet's id and the rows that shared it.
describe("cotarLinhas tracing", () => {
  const logs = capturarLogs();
  const contexto = { ...CONTEXTO, idPlanilha: "abc123" };

  it("tells the cotador which sheet and which rows each quote serves", async () => {
    const cotar = vi.fn<Cotador["cotar"]>().mockResolvedValue([opcao()]);

    await cotarLinhas([linha(), linha({ linha: 3 }), linha({ linha: 4, valorDeclarado: 60 })], contexto, { cotar });

    expect(cotar.mock.calls.map((chamada) => chamada[1])).toEqual([
      { idPlanilha: "abc123", linhas: [2, 3] },
      { idPlanilha: "abc123", linhas: [4] },
    ]);
  });

  it("logs the rows no modality can carry, since they never reach the API", async () => {
    const cotar = vi.fn<Cotador["cotar"]>().mockResolvedValue([opcao()]);

    await cotarLinhas(
      [linha(), linha({ linha: 3 })],
      { ...contexto, modalidades: [modalidade({ pesoMaximo: 0.5 })] },
      { cotar },
    );

    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: "[planilha] linhas sem modalidade para o pacote",
        idPlanilha: "abc123",
        linhas: [2, 3],
        pacote: { pesoKg: 1, alturaCm: 10, larguraCm: 20, comprimentoCm: 30 },
      }),
    );
  });
});
