// What the v2 route leaves to the caller about the account a modality is quoted
// on. Production still quotes Jadlog through the v1 route (cotacaoapi,
// rnCotacao.js), which does three things per account that v2 does not:
//
//  1. Cubes the package with the account's parameters for that modality
//     (CalculaCubagemJadlogV3) and quotes it at that weight.
//  2. Adds the account's extra cost (AdicionalCusto, or AdicionalCustoPerc of
//     the carrier's total) to the cost, before the margin.
//  3. With best-account quoting on, keeps the account with the lowest cost
//     after that extra cost.
//
// The log resolves the accounts and their parameters (fwPlanilhaApi) and sends
// one entry per account; this wraps the real cotador and does the rest, so the
// quote API itself stays untouched. Entries without any of it — every carrier
// but Jadlog today — go through exactly as they came.

import { Cotador, ModalidadeCotacao, OpcaoFrete, PedidoCotacao, RastroCotacao } from "./frete";

const arredondar = (valor: number) => Math.round((valor + Number.EPSILON) * 100) / 100;

// Porte de CalculaCubagemJadlogV3 (cotacaoapi/src/framework/fwJadlogApiPreco.js).
// A modality without parameters is quoted at the real weight.
export function pesoConsiderado(modalidade: ModalidadeCotacao, pedido: PedidoCotacao): number {
  const cubagem = modalidade.cubagem;
  if (!cubagem) return pedido.pesoKg;

  let pesoCubado = (pedido.larguraCm * pedido.alturaCm * pedido.comprimentoCm) / cubagem.fatorCubagem;

  if (cubagem.isencaoCubagem && pesoCubado <= cubagem.isencaoCubagemKg) pesoCubado = pedido.pesoKg;

  return pesoCubado >= pedido.pesoKg ? pesoCubado : pedido.pesoKg;
}

// The entry an option answers, by the log's modality id and the account.
function modalidadeDa(opcao: OpcaoFrete, pedido: PedidoCotacao): ModalidadeCotacao | undefined {
  return pedido.modalidades.find(
    (m) =>
      m.idOperador === opcao.idOperador &&
      m.idModalidadeOnlog === opcao.idModalidade &&
      (m.idCoreOperadorConfig || null) === opcao.idOperadorConfig,
  );
}

// The extra cost goes on the cost the margin is taken from. The sale price is
// linear in that cost (CalculaValorVendaFinalOperadores, fwBase.js), so the
// price the API already worked out only moves by the extra cost times the
// margin and the final-price terms.
function comAdicionalDeCusto(opcao: OpcaoFrete, modalidade: ModalidadeCotacao): OpcaoFrete {
  const fixo = modalidade.adicionalCusto ?? 0;
  const percentual = modalidade.adicionalCustoPerc ?? 0;
  const adicional = fixo > 0 ? fixo : (opcao.valorOriginal / 100) * percentual;

  if (adicional <= 0) return opcao;

  const margem =
    modalidade.descPercMargem > 0
      ? (modalidade.margemLucro / 100) * (100 - modalidade.descPercMargem)
      : modalidade.margemLucro;
  const naVendaSemAdicionais = adicional * (1 + margem / 100) * (1 - modalidade.descPercVlFinal / 100);
  const naVenda = naVendaSemAdicionais * (1 + modalidade.adicionalPercVlFinal / 100);

  // What the v1 route reports in `adicionais`, which the log keeps as is.
  const informacao: Record<string, number> = { valorAdicContrato: arredondar(adicional) };
  if (percentual > 0) informacao.percAdicContrato = arredondar(percentual);

  return {
    ...opcao,
    valorOriginal: arredondar(opcao.valorOriginal + adicional),
    valorCustoSemAdic: arredondar(opcao.valorCustoSemAdic + adicional),
    valorVendaSemAdic: arredondar(opcao.valorVendaSemAdic + naVendaSemAdicionais),
    valorFinal: arredondar(opcao.valorFinal + naVenda),
    valorFinalCheio: arredondar(opcao.valorFinalCheio + naVenda),
    informacaoAdicional: opcao.informacaoAdicional || JSON.stringify(informacao).replace(/["']/g, ""),
  };
}

// One option per modality: when it was quoted on several accounts, the lowest
// cost wins. The first to arrive stays on a tie.
function melhorPorModalidade(opcoes: OpcaoFrete[]): OpcaoFrete[] {
  const melhores = new Map<string, OpcaoFrete>();

  for (const opcao of opcoes) {
    const chave = `${opcao.idOperador}|${opcao.idModalidade}`;
    const atual = melhores.get(chave);
    if (!atual || opcao.valorCustoSemAdic < atual.valorCustoSemAdic) melhores.set(chave, opcao);
  }

  return [...melhores.values()];
}

export class CotadorPorConta implements Cotador {
  constructor(private readonly interno: Cotador) {}

  async cotar(pedido: PedidoCotacao, rastro?: RastroCotacao): Promise<OpcaoFrete[]> {
    // The request carries one weight for all its modalities, so modalities
    // cubed to different weights go out in separate requests.
    const porPeso = new Map<number, ModalidadeCotacao[]>();
    for (const modalidade of pedido.modalidades) {
      const peso = pesoConsiderado(modalidade, pedido);
      porPeso.set(peso, [...(porPeso.get(peso) ?? []), modalidade]);
    }

    const respostas = await Promise.all(
      [...porPeso].map(([pesoKg, modalidades]) => this.interno.cotar({ ...pedido, pesoKg, modalidades }, rastro)),
    );

    const opcoes = respostas.flat().map((opcao) => {
      const modalidade = modalidadeDa(opcao, pedido);
      return modalidade ? comAdicionalDeCusto(opcao, modalidade) : opcao;
    });

    return melhorPorModalidade(opcoes);
  }
}
