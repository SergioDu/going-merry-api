// Where a sheet waits between being received and being read back by the log.
//
// The upload answers as soon as the sheet is read; the quoting goes on in the
// background and the log polls for the result. That result has to live
// somewhere in between, and it lives here, in memory: no database, no Redis.
// The price of that is spelled out — a restart loses what was in flight, and a
// second replica would not see the first one's sheets. The log treats an
// unknown sheet as "send it again", so both end the same honest way.

import { LinhaCotada } from "../frete/cotarLinhas";

// A finished result is kept this long for the log to come and get it. Long
// enough to survive the user closing the tab and coming back later the same day.
export const VALIDADE_PADRAO_MS = 6 * 60 * 60 * 1000;

export interface ResultadoPlanilha {
  comErro: number;
  // Distinct quotes actually sent to the freight API for this sheet.
  cotacoes: number;
  tempoMs: number;
  linhas: LinhaCotada[];
}

export type Processamento =
  | { id: string; status: "processando"; total: number; operadores: number[] }
  | ({ id: string; status: "concluida"; total: number; operadores: number[] } & ResultadoPlanilha)
  | { id: string; status: "erro"; total: number; operadores: number[]; mensagem: string };

interface Entrada {
  processamento: Processamento;
  // When it stops being kept. A sheet still being processed has none: it always
  // finishes, one way or the other, and only then does the clock start.
  expiraEm: number | null;
}

export interface OpcoesProcessamentos {
  validadeMs?: number;
  agora?: () => number;
}

export class Processamentos {
  private readonly entradas = new Map<string, Entrada>();
  private readonly validadeMs: number;
  private readonly agora: () => number;

  constructor({ validadeMs = VALIDADE_PADRAO_MS, agora = Date.now }: OpcoesProcessamentos = {}) {
    this.validadeMs = validadeMs;
    this.agora = agora;
  }

  iniciar(id: string, total: number, operadores: number[] = []): void {
    this.entradas.set(id, { processamento: { id, status: "processando", total, operadores }, expiraEm: null });
  }

  concluir(id: string, resultado: ResultadoPlanilha): void {
    const atual = this.entradas.get(id);
    if (!atual) return;

    const { total, operadores } = atual.processamento;
    this.finalizar({ id, status: "concluida", total, operadores, ...resultado });
  }

  falhar(id: string, mensagem: string): void {
    const atual = this.entradas.get(id);
    if (!atual) return;

    const { total, operadores } = atual.processamento;
    this.finalizar({ id, status: "erro", total, operadores, mensagem });
  }

  consultar(id: string): Processamento | undefined {
    this.expirar();

    return this.entradas.get(id)?.processamento;
  }

  existe(id: string): boolean {
    return this.consultar(id) !== undefined;
  }

  private finalizar(processamento: Processamento): void {
    this.entradas.set(processamento.id, { processamento, expiraEm: this.agora() + this.validadeMs });
  }

  // Swept on read rather than on a timer: nothing to stop on shutdown, and a
  // quiet service holds on to at most what it held when it went quiet.
  private expirar(): void {
    const agora = this.agora();

    for (const [id, entrada] of this.entradas) {
      if (entrada.expiraEm !== null && entrada.expiraEm < agora) this.entradas.delete(id);
    }
  }
}
