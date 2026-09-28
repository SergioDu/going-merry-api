import { describe, expect, it } from "vitest";

import { atendeLimites, lerModalidades } from "../../src/frete/modalidades";
import { ModalidadeCotacao } from "../../src/frete/frete";

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

const PACOTE = { pesoKg: 2, alturaCm: 10, larguraCm: 20, comprimentoCm: 30 };

// The log sends the client's modalities as a JSON field of the multipart
// request. PHP is loose with types, so numbers may arrive as strings.
describe("lerModalidades", () => {
  it("reads the modalities the log sends", () => {
    const [lida] = lerModalidades(JSON.stringify([modalidade()]));

    expect(lida).toEqual(modalidade());
  });

  it("accepts numbers written as strings, the way PHP tends to send them", () => {
    const [lida] = lerModalidades(
      JSON.stringify([{ ...modalidade(), idOperador: "14", margemLucro: "12.5", pesoMaximo: "30" }]),
    );

    expect(lida.idOperador).toBe(14);
    expect(lida.margemLucro).toBe(12.5);
    expect(lida.pesoMaximo).toBe(30);
  });

  it("defaults the pricing and limit fields the log leaves out", () => {
    const [lida] = lerModalidades(
      JSON.stringify([{ idOperador: 14, idModalidade: 3, idModalidadeOnlog: 401, descricao: "PACKAGE" }]),
    );

    expect(lida.idCoreOperadorConfig).toBe(0);
    expect(lida.margemLucro).toBe(0);
    expect(lida.prazoAdicional).toBe(0);
    expect(lida.fechaPlp).toBe(1);
    expect(lida.pesoMaximo).toBe(0);
    expect(lida.logo).toBe("");
  });

  it("drops an entry that does not say which operator and modality it is", () => {
    const lidas = lerModalidades(JSON.stringify([modalidade(), { idOperador: 0, idModalidade: 3 }, { idOperador: 14 }]));

    expect(lidas).toHaveLength(1);
  });

  it("refuses something that is not a JSON list", () => {
    expect(() => lerModalidades("")).toThrow();
    expect(() => lerModalidades("{")).toThrow();
    expect(() => lerModalidades('{"idOperador": 13}')).toThrow();
  });
});

// The limits registered on the modality. The quote API does not know the
// client's registration, so they are checked here, before asking.
describe("atendeLimites", () => {
  it("lets through a modality with no limits registered", () => {
    expect(atendeLimites(modalidade(), PACOTE)).toBe(true);
  });

  it("refuses a package heavier than the modality's maximum weight", () => {
    expect(atendeLimites(modalidade({ pesoMaximo: 1 }), PACOTE)).toBe(false);
    expect(atendeLimites(modalidade({ pesoMaximo: 2 }), PACOTE)).toBe(true);
  });

  it("refuses a package with any side over the maximum per side", () => {
    expect(atendeLimites(modalidade({ medidaMaximaPorLado: 25 }), PACOTE)).toBe(false);
    expect(atendeLimites(modalidade({ medidaMaximaPorLado: 30 }), PACOTE)).toBe(true);
  });

  it("refuses a package whose sides add up to more than the maximum", () => {
    expect(atendeLimites(modalidade({ medidaMaxima: 59 }), PACOTE)).toBe(false);
    expect(atendeLimites(modalidade({ medidaMaxima: 60 }), PACOTE)).toBe(true);
  });
});
