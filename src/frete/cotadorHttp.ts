// ┌──────────────────────────────────────────────────────────────────────────┐
// │ THE SWAP POINT                                                           │
// │                                                                          │
// │ This file is the only place in the service that knows how the freight    │
// │ endpoint is called: POST /api/v2/cotacao/valores/v2 of the quote API     │
// │ (cotacao-api-v2, Conecta.Api.Price). One call prices every modality of   │
// │ every operator for one package, and the answer comes back grouped by     │
// │ operator.                                                                │
// │                                                                          │
// │ If the contract changes, only `paraRequisicao` (what we send) and        │
// │ `paraOpcao` (what we read back) move, together with their fixtures in    │
// │ test/frete/cotadorHttp.test.ts. The URL and the key come from the        │
// │ environment (FRETE_API_URL, FRETE_API_KEY).                              │
// └──────────────────────────────────────────────────────────────────────────┘

import axios, { AxiosError, AxiosInstance, AxiosResponse } from "axios";

import { Cotador, ModalidadeCotacao, OpcaoFrete, PedidoCotacao, RastroCotacao } from "./frete";
import { logError, logInfo } from "../logging/logger";

// A quote that takes longer than this is not worth waiting for: the row is
// reported as un-quotable and the rest of the sheet carries on.
const TIMEOUT_PADRAO_MS = 15000;

export interface CotadorHttpOptions {
  http?: AxiosInstance;
  // Sent as X-Api-Key.
  apiKey?: string;
  timeoutMs?: number;
}

const apenasDigitos = (cep: string) => cep.replace(/[^0-9]/g, "");

// The request body.
function paraRequisicao(pedido: PedidoCotacao) {
  return {
    cepInicial: apenasDigitos(pedido.cepOrigem),
    cepFinal: apenasDigitos(pedido.cepDestino),
    peso: pedido.pesoKg,
    altura: pedido.alturaCm,
    largura: pedido.larguraCm,
    profundidade: pedido.comprimentoCm,
    valorDeclarado: pedido.valorDeclarado,
    possuiAvisoRecebimento: pedido.comAr ? 1 : 0,
    usarCache: true,
    modalidades: pedido.modalidades.map((m) => ({
      idModalidade: m.idModalidade,
      idOperador: m.idOperador,
      idCoreOperadorConfig: m.idCoreOperadorConfig,
      idTabelaCusto: m.idTabelaCusto,
      idTabelaVenda: m.idTabelaVenda,
      margemLucro: m.margemLucro,
      descPercVlFinal: m.descPercVlFinal,
      descPercMargem: m.descPercMargem,
      descValorFixo: m.descValorFixo,
      adicionalPercVlFinal: m.adicionalPercVlFinal,
      adicionalValorFixoVlFinal: m.adicionalValorFixoVlFinal,
    })),
  };
}

// One quoted modality (mdModalidadeRetorno). Note `valorArcusto`, lower-case c:
// that is how the API names it.
interface ModalidadeResposta {
  modalidadeId: number;
  valorDeCusto?: number;
  valorCustoSemAdicionais?: number;
  valorSeguroCusto?: number;
  valorArcusto?: number;
  valorDeVenda?: number;
  valorVendaSemAdicionais?: number;
  valorSeguroVenda?: number;
  valorArVenda?: number;
  prazo?: number;
  conta?: number | null;
  success?: boolean;
  adicionais?: unknown;
}

interface RespostaCotacao {
  valores?: {
    operadores?: { operador: number; modalidades?: ModalidadeResposta[] }[];
  };
}

function textoPrazo(prazo: number): string {
  return `ENTREGA EM ${prazo} ${prazo > 1 ? "DIAS ÚTEIS" : "DIA ÚTIL"}`;
}

// The log keeps the carrier's extras as JSON with the quotes stripped
// (fwBase::removeAspas over json_encode).
function textoAdicionais(adicionais: unknown): string {
  if (adicionais === undefined || adicionais === null) return "";
  return JSON.stringify(adicionais).replace(/["']/g, "");
}

// Null when the quote has no price the log can use — the same rule as
// fwCotacaoValoresApiOnlog::AplicaCotacao.
function paraOpcao(bruta: ModalidadeResposta, modalidade: ModalidadeCotacao): OpcaoFrete | null {
  const valorCusto = bruta.valorDeCusto ?? 0;
  const valorVenda = bruta.valorDeVenda ?? 0;

  if (bruta.success === false || valorCusto <= 0 || valorVenda <= 0) return null;

  const prazo = (bruta.prazo ?? 0) + modalidade.prazoAdicional;

  return {
    idOperador: modalidade.idOperador,
    idModalidade: modalidade.idModalidadeOnlog,
    idOperadorConfig: bruta.conta ?? (modalidade.idCoreOperadorConfig || null),
    descricaoModalidade: modalidade.descricao,
    logoOperador: modalidade.logo,
    prazo,
    prazoDias: textoPrazo(prazo),
    valorFinal: valorVenda,
    valorFinalCheio: valorVenda,
    valorOriginal: valorCusto,
    valorCustoSemAdic: bruta.valorCustoSemAdicionais ?? 0,
    valorVendaSemAdic: bruta.valorVendaSemAdicionais ?? 0,
    valorSeguroContrato: bruta.valorSeguroCusto ?? 0,
    valorSeguroVenda: bruta.valorSeguroVenda ?? 0,
    valorArContrato: bruta.valorArcusto ?? 0,
    valorArVenda: bruta.valorArVenda ?? 0,
    fechaPlp: modalidade.fechaPlp,
    informacaoAdicional: textoAdicionais(bruta.adicionais),
  };
}

export class CotadorHttp implements Cotador {
  private readonly http: AxiosInstance;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly url: string,
    options: CotadorHttpOptions = {},
  ) {
    this.http = options.http ?? axios;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_PADRAO_MS;
  }

  async cotar(pedido: PedidoCotacao, rastro?: RastroCotacao): Promise<OpcaoFrete[]> {
    const requisicao = paraRequisicao(pedido);
    const inicio = Date.now();

    // Both the body and the answer go to the log, for every quote: when a sheet
    // comes back un-quotable, that is what tells a bad request from a bad answer.
    let resposta: AxiosResponse<RespostaCotacao>;
    try {
      resposta = await this.http.post<RespostaCotacao>(this.url, requisicao, {
        timeout: this.timeoutMs,
        headers: this.apiKey ? { "X-Api-Key": this.apiKey } : {},
      });
    } catch (err) {
      // A timeout or a refused connection has no response to show.
      const { response } = err as AxiosError;
      logError("cotação falhou", {
        ...rastro,
        url: this.url,
        status: response?.status,
        tempoMs: Date.now() - inicio,
        requisicao,
        resposta: response?.data,
        err: (err as Error).message,
      });
      throw err;
    }

    logInfo("cotação", {
      ...rastro,
      url: this.url,
      status: resposta.status,
      tempoMs: Date.now() - inicio,
      requisicao,
      resposta: resposta.data,
    });

    const opcoes: OpcaoFrete[] = [];

    for (const { operador, modalidades } of resposta.data?.valores?.operadores ?? []) {
      for (const bruta of modalidades ?? []) {
        // The answer names the modality the way the API knows it; the entry we
        // sent says how the log knows it.
        const modalidade = pedido.modalidades.find(
          (m) => m.idOperador === operador && m.idModalidade === bruta.modalidadeId,
        );
        if (!modalidade) continue;

        const opcao = paraOpcao(bruta, modalidade);
        if (opcao) opcoes.push(opcao);
      }
    }

    return opcoes;
  }
}
