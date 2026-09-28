// A stand-in for the freight endpoint while it is being built elsewhere.
//
// It exists so the pipeline can be run and load-tested end to end today: upload a
// thousand-row sheet, watch it parse, validate and answer. The prices are made up
// from the package's own dimensions — deterministic, so two runs of the same sheet
// are comparable — and every option says so in its own description, so a simulated
// price cannot quietly pass for a real one.
//
// The service picks this one only when FRETE_API_URL is unset; set it and
// CotadorHttp takes over.

import { Cotador, OpcaoFrete, PedidoCotacao } from "./frete";

// Cubed weight, the way carriers bill volume: the larger of the real weight and
// the box's volume over the usual 6000 divisor.
function pesoCubado(pedido: PedidoCotacao): number {
  const cubado = (pedido.alturaCm * pedido.larguraCm * pedido.comprimentoCm) / 6000;
  return Math.max(pedido.pesoKg, cubado);
}

const SEGURO = 0.02; // 2% of the declared value
const VALOR_AR = 7.5;

export class CotadorSimulado implements Cotador {
  async cotar(pedido: PedidoCotacao): Promise<OpcaoFrete[]> {
    return pedido.modalidades.map((modalidade, indice) => {
      // Each modality is a little pricier and a little faster than the one
      // before it, so a sheet comes back with something to choose between.
      const base = 14 + pesoCubado(pedido) * 2.4 + indice * 6;
      const seguroVenda = Number((pedido.valorDeclarado * SEGURO).toFixed(2));
      const arVenda = pedido.comAr ? VALOR_AR : 0;

      const custo = Number((base * 0.7).toFixed(2));
      const venda = Number(base.toFixed(2));
      const prazo = Math.max(1, 5 - indice);

      return {
        idOperador: modalidade.idOperador,
        idModalidade: modalidade.idModalidadeOnlog,
        idOperadorConfig: null,
        descricaoModalidade: `${modalidade.descricao} (SIMULADA)`,
        logoOperador: modalidade.logo,
        prazo,
        prazoDias: `${prazo} dias úteis`,
        valorFinal: Number((venda + seguroVenda).toFixed(2)),
        valorFinalCheio: Number((venda + seguroVenda).toFixed(2)),
        valorOriginal: Number((custo + seguroVenda).toFixed(2)),
        valorCustoSemAdic: custo,
        valorVendaSemAdic: venda,
        valorSeguroContrato: seguroVenda,
        valorSeguroVenda: seguroVenda,
        valorArContrato: arVenda,
        valorArVenda: arVenda,
        fechaPlp: modalidade.fechaPlp,
        informacaoAdicional: "Valor simulado — a API de frete ainda não está conectada",
      };
    });
  }
}
