import { describe, expect, it } from "vitest";

import { CotadorSimulado } from "../../src/frete/cotadorSimulado";
import { ModalidadeCotacao, PedidoCotacao } from "../../src/frete/frete";

function modalidade(idOperador: number, idModalidadeOnlog: number): ModalidadeCotacao {
  return {
    idOperador,
    idModalidade: 1,
    idCoreOperadorConfig: 0,
    idTabelaCusto: 0,
    idTabelaVenda: 0,
    margemLucro: 0,
    descPercVlFinal: 0,
    descPercMargem: 0,
    descValorFixo: 0,
    adicionalPercVlFinal: 0,
    adicionalValorFixoVlFinal: 0,
    idModalidadeOnlog,
    descricao: "PAC",
    logo: "",
    prazoAdicional: 0,
    fechaPlp: 1,
    pesoMaximo: 0,
    medidaMaximaPorLado: 0,
    medidaMaxima: 0,
  };
}

function pedido(sobrescreve: Partial<PedidoCotacao> = {}): PedidoCotacao {
  return {
    cepOrigem: "04571-010",
    cepDestino: "01001-000",
    pesoKg: 1,
    alturaCm: 10,
    larguraCm: 20,
    comprimentoCm: 30,
    valorDeclarado: 0,
    comAr: false,
    modalidades: [modalidade(13, 301), modalidade(14, 401)],
    ...sobrescreve,
  };
}

// Stands in for the freight endpoint until it exists, so the whole pipeline —
// upload, parse, validate, quote, respond — can be exercised and load-tested
// today. It must never be mistaken for real pricing.
describe("CotadorSimulado", () => {
  it("prices one option per modality it was asked about", async () => {
    const opcoes = await new CotadorSimulado().cotar(
      pedido({ modalidades: [modalidade(13, 301), modalidade(14, 401), modalidade(1, 101)] }),
    );

    expect(opcoes.map((o) => [o.idOperador, o.idModalidade])).toEqual([
      [13, 301],
      [14, 401],
      [1, 101],
    ]);
  });

  it("answers the same price for the same package, so a run is reproducible", async () => {
    const cotador = new CotadorSimulado();

    const primeira = await cotador.cotar(pedido());
    const segunda = await cotador.cotar(pedido());

    expect(primeira).toEqual(segunda);
  });

  it("charges more for a heavier package", async () => {
    const cotador = new CotadorSimulado();

    const leve = await cotador.cotar(pedido({ pesoKg: 1 }));
    const pesado = await cotador.cotar(pedido({ pesoKg: 10 }));

    expect(pesado[0].valorFinal).toBeGreaterThan(leve[0].valorFinal);
  });

  it("charges the declared-value insurance only when there is one", async () => {
    const cotador = new CotadorSimulado();

    expect((await cotador.cotar(pedido({ valorDeclarado: 0 })))[0].valorSeguroVenda).toBe(0);
    expect((await cotador.cotar(pedido({ valorDeclarado: 100 })))[0].valorSeguroVenda).toBeGreaterThan(0);
  });

  it("charges the return receipt only when the row asked for one", async () => {
    const cotador = new CotadorSimulado();

    expect((await cotador.cotar(pedido({ comAr: false })))[0].valorArVenda).toBe(0);
    expect((await cotador.cotar(pedido({ comAr: true })))[0].valorArVenda).toBeGreaterThan(0);
  });

  it("marks every option as simulated so a fake price cannot pass for a real one", async () => {
    const [opcao] = await new CotadorSimulado().cotar(pedido());

    expect(opcao.descricaoModalidade).toMatch(/SIMULAD/i);
    expect(opcao.informacaoAdicional).toMatch(/simulad/i);
  });

  it("returns nothing when there is no modality to price", async () => {
    expect(await new CotadorSimulado().cotar(pedido({ modalidades: [] }))).toEqual([]);
  });
});
