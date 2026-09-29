// A stand-in for the freight endpoint while it is being built elsewhere.
//
// It exists so the pipeline can be run and load-tested end to end today: upload a
// thousand-row sheet, watch it parse, validate and answer. The prices are made up
// from the package's own dimensions — deterministic, so two runs of the same sheet
// are comparable — and every option says so in its own description, so a simulated
// price cannot quietly pass for a real one.
//
// The service picks this one only when FREIGHT_API_URL is unset; set it and
// HttpQuoter takes over.

import { FreightOption, QuoteRequest, Quoter } from "./freight";

// Cubed weight, the way carriers bill volume: the larger of the real weight and
// the box's volume over the usual 6000 divisor.
function cubedWeight(request: QuoteRequest): number {
  const cubed = (request.heightCm * request.widthCm * request.lengthCm) / 6000;
  return Math.max(request.weightKg, cubed);
}

const INSURANCE_RATE = 0.02; // 2% of the declared value
const DELIVERY_RECEIPT_PRICE = 7.5;

export class SimulatedQuoter implements Quoter {
  async quote(request: QuoteRequest): Promise<FreightOption[]> {
    return request.modalities.map((modality, index) => {
      // Each modality is a little pricier and a little faster than the one
      // before it, so a sheet comes back with something to choose between.
      const base = 14 + cubedWeight(request) * 2.4 + index * 6;
      const insurance = Number((request.declaredValue * INSURANCE_RATE).toFixed(2));
      const deliveryReceipt = request.withDeliveryReceipt ? DELIVERY_RECEIPT_PRICE : 0;

      const cost = Number((base * 0.7).toFixed(2));
      const price = Number(base.toFixed(2));
      const deliveryDays = Math.max(1, 5 - index);

      return {
        carrierId: modality.carrierId,
        modalityId: modality.onlogModalityId,
        carrierConfigId: null,
        modalityName: `${modality.name} (SIMULADA)`,
        carrierLogo: modality.logo,
        deliveryDays,
        deliveryTimeText: `${deliveryDays} dias úteis`,
        finalPrice: Number((price + insurance).toFixed(2)),
        fullPrice: Number((price + insurance).toFixed(2)),
        cost: Number((cost + insurance).toFixed(2)),
        costWithoutExtras: cost,
        priceWithoutExtras: price,
        insuranceCost: insurance,
        insurancePrice: insurance,
        deliveryReceiptCost: deliveryReceipt,
        deliveryReceiptPrice: deliveryReceipt,
        closesPlp: modality.closesPlp,
        additionalInfo: "Valor simulado — a API de frete ainda não está conectada",
      };
    });
  }
}
