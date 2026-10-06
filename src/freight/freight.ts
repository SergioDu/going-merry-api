// The freight contract this service depends on, stated on its own terms.
//
// The endpoint that answers it is being built in a separate project. Everything
// that knows its URL, its payload and its response shape lives in
// `httpQuoter.ts` — a single adapter behind the `Quoter` port below. Swapping
// in the real endpoint means rewriting that one file; nothing else in the
// service, and nothing in the log, has to change.

// One modality the client can ship with, as the log registered it. The log
// resolves it once per sheet from the client's registration (which carriers, at
// which price tables, with which margin and discounts) — this service has no
// database and must not guess any of it.
export interface QuoteModality {
  // How the quote API knows the modality, and how it should price it. These go
  // out as they are, one entry of `modalidades` in the v2 body.
  carrierId: number;
  modalityId: number;
  carrierConfigId: number;
  costTableId: number;
  priceTableId: number;
  profitMargin: number;
  finalPriceDiscountPct: number;
  marginDiscountPct: number;
  fixedDiscount: number;
  finalPriceSurchargePct: number;
  finalPriceFixedSurcharge: number;
  // The carrier the API should price it as, when it is not `carrierId`.
  // OnlogRed is priced by the Correios tables and the v2 route only routes it
  // as Correios (13); the option still comes back under `carrierId`.
  quoteCarrierId?: number;
  // Resolved by the log from the account the entry is quoted on (Jadlog). The
  // v2 route leaves both out of the price, so they are applied here: the extra
  // cost goes on the carrier's cost before the margin, and the cubage decides
  // the weight the package is quoted at.
  extraCost?: number;
  extraCostPct?: number;
  cubage?: CubageParams;
  // How the log knows and shows it. The API's modality id is not the log's: the
  // log writes `onlogModalityId` to the temp table.
  onlogModalityId: number;
  name: string;
  logo: string;
  extraDeliveryDays: number;
  closesPlp: number;
  // The registered limits. Zero means no limit.
  maxWeightKg: number;
  maxSideCm: number;
  maxDimensionsSumCm: number;
  // OnlogRed transfer-group fields. When a modality participates in a group
  // (transferGroup > 0), the log sends both the common and the MP variant; this
  // service picks the right one per row based on origin×destination coverage.
  transferGroup?: number;
  transferGroupPriority?: number;
  coverageRanges?: CoverageRange[];
}

// A postal-code range pair that a transfer-group modality covers.
export interface CoverageRange {
  originStart: number;
  originEnd: number;
  destStart: number;
  destEnd: number;
}

// How an account cubes a package for one modality (tbCoreOperadorTipoCalculoCubagem):
// cubed weight is W × H × L / factor, and with the exemption on, a cubed weight up
// to `exemptionKg` is ignored in favour of the real one.
export interface CubageParams {
  factor: number;
  exemption: boolean;
  exemptionKg: number;
}

// What a single row needs quoted. One request, one package, one destination.
export interface QuoteRequest {
  originPostalCode: string;
  destinationPostalCode: string;
  weightKg: number;
  heightCm: number;
  widthCm: number;
  lengthCm: number;
  declaredValue: number;
  withDeliveryReceipt: boolean;
  // Only the client's modalities whose limits fit this package.
  modalities: QuoteModality[];
}

// One carrier modality priced for a row. Each field maps onto one column of
// what the log's import grid renders and writes to tbCorePostagemImportacaoTemp.
export interface FreightOption {
  carrierId: number;
  modalityId: number;
  carrierConfigId: number | null;
  modalityName: string;
  carrierLogo: string;
  deliveryDays: number;
  deliveryTimeText: string;
  // What the client pays, and the same before any contract discount.
  finalPrice: number;
  fullPrice: number;
  // What the carrier charges.
  cost: number;
  costWithoutExtras: number;
  priceWithoutExtras: number;
  insuranceCost: number;
  insurancePrice: number;
  deliveryReceiptCost: number;
  deliveryReceiptPrice: number;
  closesPlp: number;
  additionalInfo: string;
}

// Where a quote came from in the spreadsheet. Identical rows share one quote, so
// it serves a list of rows. Only for the logs — it never changes the price.
export interface QuoteTrace {
  sheetId?: string;
  rows: number[];
}

// The port. A quoter prices one package; who it asks is its own business.
export interface Quoter {
  quote(request: QuoteRequest, trace?: QuoteTrace): Promise<FreightOption[]>;
}
