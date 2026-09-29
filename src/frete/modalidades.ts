// The client's modalities, as the log sends them, and the registered limits that
// decide whether a modality can carry a package at all.

import { ModalidadeCotacao, ParametroCubagem } from "./frete";

type Bruta = Record<string, unknown>;

// PHP sends numbers as strings as often as not; anything unreadable is zero.
function numero(bruta: Bruta, campo: string, padrao = 0): number {
  const valor = bruta[campo];
  if (valor === undefined || valor === null || valor === "") return padrao;

  const lido = Number(valor);
  return Number.isFinite(lido) ? lido : padrao;
}

function texto(bruta: Bruta, campo: string): string {
  const valor = bruta[campo];
  return valor === undefined || valor === null ? "" : String(valor);
}

// The optional fields go on the modality only when the log sent them, so an
// entry without them reads exactly as before.
function opcionais(bruta: Bruta): Partial<ModalidadeCotacao> {
  const lidos: Partial<ModalidadeCotacao> = {};

  if (numero(bruta, "idOperadorCotacao") > 0) lidos.idOperadorCotacao = numero(bruta, "idOperadorCotacao");
  if (bruta.adicionalCusto !== undefined) lidos.adicionalCusto = numero(bruta, "adicionalCusto");
  if (bruta.adicionalCustoPerc !== undefined) lidos.adicionalCustoPerc = numero(bruta, "adicionalCustoPerc");

  const cubagem = bruta.cubagem;
  if (typeof cubagem === "object" && cubagem !== null) {
    const parametro: ParametroCubagem = {
      fatorCubagem: numero(cubagem as Bruta, "fatorCubagem"),
      isencaoCubagem: numero(cubagem as Bruta, "isencaoCubagem") === 1,
      isencaoCubagemKg: numero(cubagem as Bruta, "isencaoCubagemKg"),
    };
    if (parametro.fatorCubagem > 0) lidos.cubagem = parametro;
  }

  return lidos;
}

// Reads the `modalidades` field of the upload. Throws when it is not a JSON list —
// that is a bug in the caller, not something to quote around. An entry that does
// not say which operator and modality it is cannot be quoted and is dropped.
export function lerModalidades(conteudo: string): ModalidadeCotacao[] {
  const lido: unknown = JSON.parse(conteudo);

  if (!Array.isArray(lido)) throw new Error("modalidades não é uma lista");

  return lido
    .filter((item): item is Bruta => typeof item === "object" && item !== null)
    .map(
      (bruta): ModalidadeCotacao => ({
        idOperador: numero(bruta, "idOperador"),
        idModalidade: numero(bruta, "idModalidade"),
        idCoreOperadorConfig: numero(bruta, "idCoreOperadorConfig"),
        idTabelaCusto: numero(bruta, "idTabelaCusto"),
        idTabelaVenda: numero(bruta, "idTabelaVenda"),
        margemLucro: numero(bruta, "margemLucro"),
        descPercVlFinal: numero(bruta, "descPercVlFinal"),
        descPercMargem: numero(bruta, "descPercMargem"),
        descValorFixo: numero(bruta, "descValorFixo"),
        adicionalPercVlFinal: numero(bruta, "adicionalPercVlFinal"),
        adicionalValorFixoVlFinal: numero(bruta, "adicionalValorFixoVlFinal"),
        idModalidadeOnlog: numero(bruta, "idModalidadeOnlog"),
        descricao: texto(bruta, "descricao"),
        logo: texto(bruta, "logo"),
        prazoAdicional: numero(bruta, "prazoAdicional"),
        // The log closes the PLP by default.
        fechaPlp: numero(bruta, "fechaPlp", 1),
        pesoMaximo: numero(bruta, "pesoMaximo"),
        medidaMaximaPorLado: numero(bruta, "medidaMaximaPorLado"),
        medidaMaxima: numero(bruta, "medidaMaxima"),
        ...opcionais(bruta),
      }),
    )
    .filter((modalidade) => modalidade.idOperador > 0 && modalidade.idModalidade > 0);
}

export interface Pacote {
  pesoKg: number;
  alturaCm: number;
  larguraCm: number;
  comprimentoCm: number;
}

// Same rules as fwCotacaoValoresApiOnlog::ValidaLimitesModalidade in the log. The
// declared-value ceiling is not here: it depends on the invoice, and the log
// checks it when it writes the row.
export function atendeLimites(modalidade: ModalidadeCotacao, pacote: Pacote): boolean {
  const { pesoKg, alturaCm, larguraCm, comprimentoCm } = pacote;

  if (modalidade.pesoMaximo > 0 && pesoKg > modalidade.pesoMaximo) return false;

  const porLado = modalidade.medidaMaximaPorLado;
  if (porLado > 0 && (alturaCm > porLado || larguraCm > porLado || comprimentoCm > porLado)) return false;

  if (modalidade.medidaMaxima > 0 && alturaCm + larguraCm + comprimentoCm > modalidade.medidaMaxima) return false;

  return true;
}
