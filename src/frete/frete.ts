// The freight contract this service depends on, stated on its own terms.
//
// The endpoint that answers it is being built in a separate project. Everything
// that knows its URL, its payload and its response shape lives in
// `cotadorHttp.ts` — a single adapter behind the `Cotador` port below. Swapping
// in the real endpoint means rewriting that one file; nothing else in the
// service, and nothing in the log, has to change.

// One modality the client can ship with, as the log registered it. The log
// resolves it once per sheet from the client's registration (which carriers, at
// which price tables, with which margin and discounts) — this service has no
// database and must not guess any of it.
export interface ModalidadeCotacao {
  // How the quote API knows the modality, and how it should price it. These go
  // out as they are, one entry of `modalidades` in the v2 body.
  idOperador: number;
  idModalidade: number;
  idCoreOperadorConfig: number;
  idTabelaCusto: number;
  idTabelaVenda: number;
  margemLucro: number;
  descPercVlFinal: number;
  descPercMargem: number;
  descValorFixo: number;
  adicionalPercVlFinal: number;
  adicionalValorFixoVlFinal: number;
  // How the log knows and shows it. The API's modality id is not the log's: the
  // log writes `idModalidadeOnlog` to the temp table.
  idModalidadeOnlog: number;
  descricao: string;
  logo: string;
  prazoAdicional: number;
  fechaPlp: number;
  // The registered limits. Zero means no limit.
  pesoMaximo: number;
  medidaMaximaPorLado: number;
  medidaMaxima: number;
}

// What a single row needs quoted. One request, one package, one destination.
export interface PedidoCotacao {
  cepOrigem: string;
  cepDestino: string;
  pesoKg: number;
  alturaCm: number;
  larguraCm: number;
  comprimentoCm: number;
  valorDeclarado: number;
  comAr: boolean;
  // Only the client's modalities whose limits fit this package.
  modalidades: ModalidadeCotacao[];
}

// One carrier modality priced for a row. The field names mirror what the log's
// import grid renders and writes to tbCorePostagemImportacaoTemp, so the log maps
// them straight across instead of translating a second vocabulary.
export interface OpcaoFrete {
  idOperador: number;
  idModalidade: number;
  idOperadorConfig: number | null;
  descricaoModalidade: string;
  logoOperador: string;
  prazo: number;
  prazoDias: string;
  // What the client pays, and the same before any contract discount.
  valorFinal: number;
  valorFinalCheio: number;
  // What the carrier charges.
  valorOriginal: number;
  valorCustoSemAdic: number;
  valorVendaSemAdic: number;
  valorSeguroContrato: number;
  valorSeguroVenda: number;
  valorArContrato: number;
  valorArVenda: number;
  fechaPlp: number;
  informacaoAdicional: string;
}

// Where a quote came from in the spreadsheet. Identical rows share one quote, so
// it serves a list of rows. Only for the logs — it never changes the price.
export interface RastroCotacao {
  idPlanilha?: string;
  linhas: number[];
}

// The port. A cotador prices one package; who it asks is its own business.
export interface Cotador {
  cotar(pedido: PedidoCotacao, rastro?: RastroCotacao): Promise<OpcaoFrete[]>;
}
