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
// one entry per account; this wraps the real quoter and does the rest, so the
// quote API itself stays untouched. Entries without any of it — every carrier
// but Jadlog today — go through exactly as they came.

import { FreightOption, QuoteModality, QuoteRequest, QuoteTrace, Quoter } from "./freight";

const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

// Port of CalculaCubagemJadlogV3 (cotacaoapi/src/framework/fwJadlogApiPreco.js).
// A modality without parameters is quoted at the real weight.
export function billableWeight(modality: QuoteModality, request: QuoteRequest): number {
  const cubage = modality.cubage;
  if (!cubage) return request.weightKg;

  let cubedWeight = (request.widthCm * request.heightCm * request.lengthCm) / cubage.factor;

  if (cubage.exemption && cubedWeight <= cubage.exemptionKg) cubedWeight = request.weightKg;

  return cubedWeight >= request.weightKg ? cubedWeight : request.weightKg;
}

// The entry an option answers, by the log's modality id and the account.
function modalityOf(option: FreightOption, request: QuoteRequest): QuoteModality | undefined {
  return request.modalities.find(
    (m) =>
      m.carrierId === option.carrierId &&
      m.onlogModalityId === option.modalityId &&
      (m.carrierConfigId || null) === option.carrierConfigId,
  );
}

// The extra cost goes on the cost the margin is taken from. The sale price is
// linear in that cost (CalculaValorVendaFinalOperadores, fwBase.js), so the
// price the API already worked out only moves by the extra cost times the
// margin and the final-price terms.
function withExtraCost(option: FreightOption, modality: QuoteModality): FreightOption {


  const fixed = modality.extraCost ?? 0;
  const percent = modality.extraCostPct ?? 0;
  // const extra = fixed > 0 ? fixed : (option.cost / 100) * percent;
  const extra = 0; // The cotation api already sums the extra cost to the cost, so we don't need to add it again.

  if (extra <= 0) return option;

  const margin =
    modality.marginDiscountPct > 0
      ? (modality.profitMargin / 100) * (100 - modality.marginDiscountPct)
      : modality.profitMargin;
  const onPriceWithoutExtras = extra * (1 + margin / 100) * (1 - modality.finalPriceDiscountPct / 100);
  const onPrice = onPriceWithoutExtras * (1 + modality.finalPriceSurchargePct / 100);

  // What the v1 route reports in `adicionais`, which the log keeps as is. The
  // keys are the log's, not ours.
  const info: Record<string, number> = { valorAdicContrato: round(extra) };
  if (percent > 0) info.percAdicContrato = round(percent);

  return {
    ...option,
    cost: round(option.cost + extra),
    costWithoutExtras: round(option.costWithoutExtras + extra),
    priceWithoutExtras: round(option.priceWithoutExtras + onPriceWithoutExtras),
    finalPrice: round(option.finalPrice + onPrice),
    fullPrice: round(option.fullPrice + onPrice),
    additionalInfo: option.additionalInfo || JSON.stringify(info).replace(/["']/g, ""),
  };
}

// One option per modality: when it was quoted on several accounts, the lowest
// cost wins. The first to arrive stays on a tie.
function cheapestPerModality(options: FreightOption[]): FreightOption[] {
  const cheapest = new Map<string, FreightOption>();

  for (const option of options) {
    const key = `${option.carrierId}|${option.modalityId}`;
    const current = cheapest.get(key);
    if (!current || option.costWithoutExtras < current.costWithoutExtras) cheapest.set(key, option);
  }

  return [...cheapest.values()];
}

export class PerAccountQuoter implements Quoter {
  constructor(private readonly inner: Quoter) {}

  async quote(request: QuoteRequest, trace?: QuoteTrace): Promise<FreightOption[]> {
    // The request carries one weight for all its modalities, so modalities
    // cubed to different weights go out in separate requests.
    const byWeight = new Map<number, QuoteModality[]>();
    for (const modality of request.modalities) {
      const weight = billableWeight(modality, request);
      byWeight.set(weight, [...(byWeight.get(weight) ?? []), modality]);
    }

    const responses = await Promise.all(
      [...byWeight].map(([weightKg, modalities]) => this.inner.quote({ ...request, weightKg, modalities }, trace)),
    );

    const options = responses.flat().map((option) => {
      const modality = modalityOf(option, request);
      return modality ? withExtraCost(option, modality) : option;
    });

    return cheapestPerModality(options);
  }
}
