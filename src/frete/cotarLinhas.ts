// Prices a whole sheet.
//
// Two things make a thousand rows finish quickly, and neither needs a queue or a
// cache server:
//
//  1. Rows that would ask the same question are asked once. A real import is a
//     thousand rows of a handful of products going to a handful of cities, so the
//     distinct quotes are usually a small fraction of the rows. The map holding
//     them lives inside this call and dies with it — nothing is cached between
//     requests, so a price can never go stale.
//  2. The distinct quotes run concurrently, with a fixed ceiling so a big import
//     does not flood the freight API.
//
// A row that fails validation is never quoted, and a quote that fails takes down
// its own row only — the other 999 still come back.

import { Cotador, ModalidadeCotacao, OpcaoFrete, PedidoCotacao } from "./frete";
import { atendeLimites } from "./modalidades";
import { logInfo } from "../logging/logger";
import { LinhaPlanilha } from "../planilha/linha";

// How many quotes are allowed in flight at once. Tuned by the caller (the route
// reads FRETE_CONCORRENCIA); this is the default.
export const CONCORRENCIA_PADRAO = 20;

// What the sheet as a whole contributes to every quote: it is the same for all
// rows, so it is not repeated row by row.
export interface ContextoCotacao {
  cepOrigem: string;
  // The client's modalities, resolved by the log for the carriers picked on the
  // import screen.
  modalidades: ModalidadeCotacao[];
  // The import's hash in the log. Tags the logs of every quote of the sheet.
  idPlanilha?: string;
}

export interface LinhaCotada extends LinhaPlanilha {
  opcoes: OpcaoFrete[];
}

export interface ResultadoCotacao {
  linhas: LinhaCotada[];
  // How many quotes actually went out, against how many rows came in. On a real
  // sheet this is a small fraction of the rows, and it is the first thing to look
  // at when an import is slow.
  cotacoes: number;
}

function montarPedido(linha: LinhaPlanilha, contexto: ContextoCotacao): PedidoCotacao {
  return {
    cepOrigem: contexto.cepOrigem,
    cepDestino: linha.destinatario.cep,
    pesoKg: linha.objeto.pesoKg,
    alturaCm: linha.objeto.alturaCm,
    larguraCm: linha.objeto.larguraCm,
    comprimentoCm: linha.objeto.comprimentoCm,
    valorDeclarado: linha.valorDeclarado,
    comAr: linha.comAr,
    // The limits depend only on the package, which is part of the key below, so
    // two rows with the same key always end up asking about the same modalities.
    modalidades: contexto.modalidades.filter((modalidade) => atendeLimites(modalidade, linha.objeto)),
  };
}

// Everything the price depends on, and nothing else — the recipient's name or
// phone number must not split two otherwise identical quotes.
function chave(pedido: PedidoCotacao): string {
  return [
    pedido.cepOrigem,
    pedido.cepDestino,
    pedido.pesoKg,
    pedido.alturaCm,
    pedido.larguraCm,
    pedido.comprimentoCm,
    pedido.valorDeclarado,
    pedido.comAr ? "1" : "0",
  ].join("|");
}

// Runs `tarefa` over every item with at most `limite` of them in flight. Results
// come back in the input's order regardless of who finishes first.
async function emLotes<T, R>(itens: T[], limite: number, tarefa: (item: T) => Promise<R>): Promise<R[]> {
  const resultados: R[] = new Array(itens.length);
  let proximo = 0;

  async function trabalhador(): Promise<void> {
    while (proximo < itens.length) {
      const indice = proximo++;
      resultados[indice] = await tarefa(itens[indice]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, () => trabalhador()));

  return resultados;
}

export async function cotarLinhas(
  linhas: LinhaPlanilha[],
  contexto: ContextoCotacao,
  cotador: Cotador,
  concorrencia: number = CONCORRENCIA_PADRAO,
): Promise<ResultadoCotacao> {
  // A row that already failed validation has nothing to price: its CEP or its
  // weight is exactly what is missing.
  const aCotar = linhas.filter((linha) => linha.erros.length === 0);

  // One entry per distinct quote, with the rows it serves, built before anything
  // is dispatched so the duplicates are gone by the time the requests start.
  const grupos = new Map<string, { pedido: PedidoCotacao; linhas: number[] }>();
  for (const linha of aCotar) {
    const pedido = montarPedido(linha, contexto);
    const id = chave(pedido);
    const grupo = grupos.get(id);
    if (grupo) grupo.linhas.push(linha.linha);
    else grupos.set(id, { pedido, linhas: [linha.linha] });
  }

  // A package no modality can carry is not worth a request: its answer is known.
  // It never reaches the API, so this log is the only trace it leaves.
  const distintos: [string, { pedido: PedidoCotacao; linhas: number[] }][] = [];
  for (const [id, grupo] of grupos) {
    if (grupo.pedido.modalidades.length > 0) {
      distintos.push([id, grupo]);
      continue;
    }

    const { pesoKg, alturaCm, larguraCm, comprimentoCm } = grupo.pedido;
    logInfo("linhas sem modalidade para o pacote", {
      idPlanilha: contexto.idPlanilha,
      linhas: grupo.linhas,
      pacote: { pesoKg, alturaCm, larguraCm, comprimentoCm },
    });
  }

  const respostas = await emLotes(distintos, concorrencia, async ([, { pedido, linhas }]) => {
    try {
      const opcoes = await cotador.cotar(pedido, { idPlanilha: contexto.idPlanilha, linhas });
      // Cheapest first: the log preselects the first option of the row.
      return { opcoes: [...opcoes].sort((a, b) => a.valorFinal - b.valorFinal), falhou: false };
    } catch {
      return { opcoes: [] as OpcaoFrete[], falhou: true };
    }
  });

  const porChave = new Map(distintos.map(([id], indice) => [id, respostas[indice]]));

  const cotadas = linhas.map((linha): LinhaCotada => {
    if (linha.erros.length > 0) return { ...linha, opcoes: [] };

    const pedido = montarPedido(linha, contexto);

    if (pedido.modalidades.length === 0) {
      return { ...linha, opcoes: [], erros: [...linha.erros, "Nenhuma modalidade compatível"] };
    }

    const resposta = porChave.get(chave(pedido));

    if (!resposta || resposta.falhou) {
      return { ...linha, opcoes: [], erros: [...linha.erros, "Não foi possível cotar o frete desta linha"] };
    }

    if (resposta.opcoes.length === 0) {
      return { ...linha, opcoes: [], erros: [...linha.erros, "Nenhuma modalidade compatível"] };
    }

    return { ...linha, opcoes: resposta.opcoes };
  });

  return { linhas: cotadas, cotacoes: distintos.length };
}
