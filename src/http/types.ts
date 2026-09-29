import { Quoter } from "../freight/freight";
import { SheetJobs } from "../sheet/jobs";

// Everything the HTTP layer depends on, injected so tests can supply a fake
// quoter and main.ts can supply the real one (the freight API, or the simulated
// stand-in while that endpoint is being built).
export interface ServerDeps {
  quoter: Quoter;
  // How many quotes may be in flight at once for a single sheet.
  concurrency: number;
  // Sheets being quoted in the background, and the results waiting for the log.
  jobs: SheetJobs;
}
