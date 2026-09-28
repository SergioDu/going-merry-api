import { Cotador } from "../frete/frete";
import { Processamentos } from "../planilha/processamentos";

// Everything the HTTP layer depends on, injected so tests can supply a fake
// cotador and main.ts can supply the real one (the freight API, or the simulated
// stand-in while that endpoint is being built).
export interface ServerDeps {
  cotador: Cotador;
  // How many quotes may be in flight at once for a single sheet.
  concorrencia: number;
  // Sheets being quoted in the background, and the results waiting for the log.
  processamentos: Processamentos;
}
