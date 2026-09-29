// ┌──────────────────────────────────────────────────────────────────────────┐
// │ THE SWAP POINT                                                           │
// │                                                                          │
// │ This file is the only place in the service that knows how the freight    │
// │ endpoint is called: POST /api/v2/cotacao/valores/v2 of the quote API     │
// │ (cotacao-api-v2, Conecta.Api.Price). One call prices every modality of   │
// │ every carrier for one package, and the answer comes back grouped by      │
// │ carrier.                                                                 │
// │                                                                          │
// │ If the contract changes, only `toRequestBody` (what we send) and         │
// │ `toOption` (what we read back) move, together with their fixtures in     │
// │ test/freight/httpQuoter.test.ts. The URL and the key come from the       │
// │ environment (FREIGHT_API_URL, FREIGHT_API_KEY).                          │
// │                                                                          │
// │ The body and the response keep the quote API's own Portuguese names:     │
// │ that contract belongs to the other project.                              │
// └──────────────────────────────────────────────────────────────────────────┘

import axios, { AxiosError, AxiosInstance, AxiosResponse } from "axios";

import { FreightOption, QuoteModality, QuoteRequest, QuoteTrace, Quoter } from "./freight";
import { logError, logInfo } from "../logging/logger";

// A quote that takes longer than this is not worth waiting for: the row is
// reported as un-quotable and the rest of the sheet carries on.
const DEFAULT_TIMEOUT_MS = 15000;

export interface HttpQuoterOptions {
  http?: AxiosInstance;
  // Sent as X-Api-Key.
  apiKey?: string;
  timeoutMs?: number;
}

const digitsOnly = (postalCode: string) => postalCode.replace(/[^0-9]/g, "");

const quoteCarrier = (m: QuoteModality) => m.quoteCarrierId ?? m.carrierId;

// The request body.
function toRequestBody(request: QuoteRequest) {
  return {
    cepInicial: digitsOnly(request.originPostalCode),
    cepFinal: digitsOnly(request.destinationPostalCode),
    peso: request.weightKg,
    altura: request.heightCm,
    largura: request.widthCm,
    profundidade: request.lengthCm,
    valorDeclarado: request.declaredValue,
    possuiAvisoRecebimento: request.withDeliveryReceipt ? 1 : 0,
    usarCache: true,
    modalidades: request.modalities.map((m) => ({
      idModalidade: m.modalityId,
      idOperador: quoteCarrier(m),
      idCoreOperadorConfig: m.carrierConfigId,
      idTabelaCusto: m.costTableId,
      idTabelaVenda: m.priceTableId,
      margemLucro: m.profitMargin,
      descPercVlFinal: m.finalPriceDiscountPct,
      descPercMargem: m.marginDiscountPct,
      descValorFixo: m.fixedDiscount,
      adicionalPercVlFinal: m.finalPriceSurchargePct,
      adicionalValorFixoVlFinal: m.finalPriceFixedSurcharge,
    })),
  };
}

// One quoted modality (mdModalidadeRetorno). The casing is not reliable: a fresh
// answer comes in camelCase, one served from the API's cache in PascalCase, and
// the AR cost is `valorArcusto` in one build and `valorArCusto` in another. Read
// it through `normalize`, never field by field.
interface QuotedModality {
  modalityId: number;
  cost?: number;
  costWithoutExtras?: number;
  insuranceCost?: number;
  deliveryReceiptCost?: number;
  price?: number;
  priceWithoutExtras?: number;
  insurancePrice?: number;
  deliveryReceiptPrice?: number;
  deliveryDays?: number;
  account?: number | null;
  success?: boolean;
  extras?: unknown;
}

interface QuoteResponse {
  valores?: {
    operadores?: { operador: number; modalidades?: Record<string, unknown>[] }[];
  };
}

function normalize(raw: Record<string, unknown>): QuotedModality {
  const fields = new Map(Object.entries(raw).map(([name, value]) => [name.toLowerCase(), value]));
  const num = (name: string) => fields.get(name) as number | undefined;

  return {
    modalityId: Number(fields.get("modalidadeid")),
    cost: num("valordecusto"),
    costWithoutExtras: num("valorcustosemadicionais"),
    insuranceCost: num("valorsegurocusto"),
    deliveryReceiptCost: num("valorarcusto"),
    price: num("valordevenda"),
    priceWithoutExtras: num("valorvendasemadicionais"),
    insurancePrice: num("valorsegurovenda"),
    deliveryReceiptPrice: num("valorarvenda"),
    deliveryDays: num("prazo"),
    account: fields.get("conta") as number | null | undefined,
    success: fields.get("success") as boolean | undefined,
    extras: fields.get("adicionais"),
  };
}

function deliveryTimeText(days: number): string {
  return `ENTREGA EM ${days} ${days > 1 ? "DIAS ÚTEIS" : "DIA ÚTIL"}`;
}

// The log keeps the carrier's extras as JSON with the quotes stripped
// (fwBase::removeAspas over json_encode).
function extrasText(extras: unknown): string {
  if (extras === undefined || extras === null) return "";
  return JSON.stringify(extras).replace(/["']/g, "");
}

// Null when the quote has no price the log can use — the same rule as
// fwCotacaoValoresApiOnlog::AplicaCotacao.
function toOption(quoted: QuotedModality, modality: QuoteModality): FreightOption | null {
  const cost = quoted.cost ?? 0;
  const price = quoted.price ?? 0;

  if (quoted.success === false || cost <= 0 || price <= 0) return null;

  const deliveryDays = (quoted.deliveryDays ?? 0) + modality.extraDeliveryDays;

  return {
    carrierId: modality.carrierId,
    modalityId: modality.onlogModalityId,
    carrierConfigId: quoted.account ?? (modality.carrierConfigId || null),
    modalityName: modality.name,
    carrierLogo: modality.logo,
    deliveryDays,
    deliveryTimeText: deliveryTimeText(deliveryDays),
    finalPrice: price,
    fullPrice: price,
    cost,
    costWithoutExtras: quoted.costWithoutExtras ?? 0,
    priceWithoutExtras: quoted.priceWithoutExtras ?? 0,
    insuranceCost: quoted.insuranceCost ?? 0,
    insurancePrice: quoted.insurancePrice ?? 0,
    deliveryReceiptCost: quoted.deliveryReceiptCost ?? 0,
    deliveryReceiptPrice: quoted.deliveryReceiptPrice ?? 0,
    closesPlp: modality.closesPlp,
    additionalInfo: extrasText(quoted.extras),
  };
}

export class HttpQuoter implements Quoter {
  private readonly http: AxiosInstance;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly url: string,
    options: HttpQuoterOptions = {},
  ) {
    this.http = options.http ?? axios;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async quote(request: QuoteRequest, trace?: QuoteTrace): Promise<FreightOption[]> {
    const body = toRequestBody(request);
    const startedAt = Date.now();

    // Both the body and the answer go to the log, for every quote: when a sheet
    // comes back un-quotable, that is what tells a bad request from a bad answer.
    let response: AxiosResponse<QuoteResponse>;
    try {
      response = await this.http.post<QuoteResponse>(this.url, body, {
        timeout: this.timeoutMs,
        headers: this.apiKey ? { "X-Api-Key": this.apiKey } : {},
      });
    } catch (err) {
      // A timeout or a refused connection has no response to show.
      const { response: failed } = err as AxiosError;
      logError("cotação falhou", {
        ...trace,
        url: this.url,
        status: failed?.status,
        durationMs: Date.now() - startedAt,
        request: body,
        response: failed?.data,
        err: (err as Error).message,
      });
      throw err;
    }

    logInfo("cotação", {
      ...trace,
      url: this.url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      request: body,
      response: response.data,
    });

    const options: FreightOption[] = [];

    // The answer names the modality the way the API knows it; the entry we sent
    // says how the log knows it. The same carrier and modality can go out more
    // than once — one per account, or a Correios and an OnlogRed modality priced
    // alike — so the account tells them apart when both sides name one, and each
    // entry answers once, in the order it was sent.
    const answered = new Set<number>();

    for (const { operador, modalidades } of response.data?.valores?.operadores ?? []) {
      for (const quoted of (modalidades ?? []).map(normalize)) {
        const index = request.modalities.findIndex(
          (m, i) =>
            !answered.has(i) &&
            quoteCarrier(m) === operador &&
            m.modalityId === quoted.modalityId &&
            (m.carrierConfigId <= 0 || quoted.account == null || m.carrierConfigId === quoted.account),
        );
        if (index < 0) continue;
        answered.add(index);

        const option = toOption(quoted, request.modalities[index]);
        if (option) options.push(option);
      }
    }

    return options;
  }
}
