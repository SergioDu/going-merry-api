// Maps one raw spreadsheet row onto the normalized shape the log persists, and
// reports the row-level problems the log would have reported for it.
//
// Only the checks that can be answered from the row itself live here: required
// fields, formats and check digits. The ones that need the client's registration
// or an external service — the sender's data, the CEP lookup at Correios, the
// state registration (IE), the declared-value ceiling per carrier modality —
// stay in the log, which already has that context.

import {
  digitsOnly,
  formatPhone,
  formatPostalCode,
  formatTaxId,
  isValidTaxId,
  splitAddress,
  stripAccents,
} from "./text";

export interface Recipient {
  name: string;
  // The street cell split in two: the type ("RUA", "AVENIDA") and the name.
  streetType: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
  postalCode: string;
  // CPF or CNPJ.
  taxId: string;
  // RG for a person, state registration (IE) for a company.
  stateRegistration: string;
  phone: string;
  email: string;
}

export interface Parcel {
  weightKg: number;
  heightCm: number;
  widthCm: number;
  lengthCm: number;
  diameterCm: number;
}

export interface SheetRow {
  // 1-based position in the sheet, header included, so an error message can point
  // the user at the line they need to fix.
  line: number;
  recipient: Recipient;
  parcel: Parcel;
  goodsValue: number;
  declaredValue: number;
  invoiceNumber: string;
  invoiceAccessKey: string;
  // AR (aviso de recebimento): the signed proof of delivery.
  withDeliveryReceipt: boolean;
  // The client's own reference for the shipment (CONTROLE_REMETENTE).
  senderReference: string;
  errors: string[];
}

// Column order of the "Modelo - Padrao" sheet (layout 1), which is what the log
// reads by numeric index. Named here so a column move is a one-line change.
export const COLUMNS = {
  NAME: 0,
  STREET: 1,
  NUMBER: 2,
  COMPLEMENT: 3,
  DISTRICT: 4,
  CITY: 5,
  STATE: 6,
  POSTAL_CODE: 7,
  TAX_ID: 8,
  STATE_REGISTRATION: 9,
  PHONE: 10,
  EMAIL: 11,
  WEIGHT_KG: 12,
  HEIGHT_CM: 13,
  WIDTH_CM: 14,
  LENGTH_CM: 15,
  DIAMETER_CM: 16,
  GOODS_VALUE: 17,
  DECLARED_VALUE: 18,
  INVOICE_NUMBER: 19,
  INVOICE_ACCESS_KEY: 20,
  DELIVERY_RECEIPT: 21,
  SENDER_REFERENCE: 22,
} as const;

// A cell as a trimmed string. A short row (Excel drops trailing empty cells)
// reads as empty rather than blowing up.
function text(raw: unknown[], column: number): string {
  const value = raw[column];
  if (value === null || value === undefined) return "";

  return String(value).trim();
}

// A numeric cell. Excel hands numbers over as numbers, but a sheet typed by hand
// often carries them as text in the Brazilian format ("1.250,50") — both read the
// same way here. The dot only counts as a thousands separator when a comma is
// present, otherwise it is the decimal point of a plain number. An empty cell is
// NaN so the caller can tell "empty" from "zero", which the log's own validation
// also distinguishes.
function num(raw: unknown[], column: number): number {
  const value = text(raw, column);
  if (value === "") return NaN;

  const normalized = value.includes(",") ? value.replace(/\./g, "").replace(",", ".") : value;

  return Number(normalized);
}

// A numeric cell that is optional: an empty or unreadable value counts as zero,
// like the log does for the merchandise and declared values.
function numOrZero(raw: unknown[], column: number): number {
  const value = num(raw, column);
  return Number.isNaN(value) ? 0 : value;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function mapRow(raw: unknown[], lineNumber: number): SheetRow {
  const errors: string[] = [];

  // The sheet carries the street type and the street name in one cell. The log
  // splits them on the first space, strips accents only from the street name, and
  // falls back to "RUA" / a single space when either side comes out empty.
  const rawAddress = text(raw, COLUMNS.STREET);
  const streetType = splitAddress(rawAddress).streetType.trim() || "RUA";
  const street = splitAddress(stripAccents(rawAddress)).street.trim() || " ";

  const rawPostalCode = text(raw, COLUMNS.POSTAL_CODE);
  const postalCode = formatPostalCode(rawPostalCode);

  const rawTaxId = text(raw, COLUMNS.TAX_ID);
  const taxId = formatTaxId(rawTaxId);

  const email = text(raw, COLUMNS.EMAIL).toLowerCase();

  const recipient: Recipient = {
    name: stripAccents(text(raw, COLUMNS.NAME)),
    streetType,
    street,
    number: text(raw, COLUMNS.NUMBER),
    complement: stripAccents(text(raw, COLUMNS.COMPLEMENT)),
    district: stripAccents(text(raw, COLUMNS.DISTRICT)),
    city: stripAccents(text(raw, COLUMNS.CITY)),
    state: text(raw, COLUMNS.STATE).toUpperCase(),
    postalCode: postalCode ?? "",
    taxId: taxId ?? "",
    stateRegistration: text(raw, COLUMNS.STATE_REGISTRATION),
    phone: formatPhone(text(raw, COLUMNS.PHONE)),
    email,
  };

  const parcel: Parcel = {
    weightKg: numOrZero(raw, COLUMNS.WEIGHT_KG),
    heightCm: numOrZero(raw, COLUMNS.HEIGHT_CM),
    widthCm: numOrZero(raw, COLUMNS.WIDTH_CM),
    lengthCm: numOrZero(raw, COLUMNS.LENGTH_CM),
    diameterCm: numOrZero(raw, COLUMNS.DIAMETER_CM),
  };

  const invoiceAccessKey = text(raw, COLUMNS.INVOICE_ACCESS_KEY);
  const rawDeliveryReceipt = text(raw, COLUMNS.DELIVERY_RECEIPT).toUpperCase();

  // ── Row-level validation, in the log's own wording ──────────────────────
  if (recipient.name === "") errors.push("Nome do destinatário não pode ser vazio");
  if (recipient.number === "") errors.push("Número do endereço do destinatário não pode ser vazio");
  if (recipient.district === "") errors.push("Bairro do destinatário não pode ser vazio");
  if (recipient.city === "") errors.push("Cidade do destinatário não pode ser vazio");
  if (recipient.state === "") errors.push("UF do destinatário não pode ser vazio");

  if (rawPostalCode === "") {
    errors.push("CEP do destinatário não pode ser vazio");
  } else if (postalCode === null) {
    errors.push("CEP do destinatário inválido");
  }

  if (rawTaxId === "") {
    errors.push("CPF/CNPJ do destinatário não pode ser vazio");
  } else if (!isValidTaxId(rawTaxId)) {
    errors.push("CPF/CNPJ do destinatário inválido");
  }

  if (email !== "" && !EMAIL.test(email)) errors.push("Email do destinatário inválido");

  if (Number.isNaN(num(raw, COLUMNS.WEIGHT_KG))) errors.push("O peso do objeto não pode ser vazio");
  if (Number.isNaN(num(raw, COLUMNS.HEIGHT_CM))) errors.push("Altura do objeto não pode ser vazia");
  if (Number.isNaN(num(raw, COLUMNS.WIDTH_CM))) errors.push("Largura do objeto não pode ser vazia");
  if (Number.isNaN(num(raw, COLUMNS.LENGTH_CM))) errors.push("Profundidade do objeto não pode ser vazia");

  if (invoiceAccessKey !== "") {
    if (/[a-z]/i.test(invoiceAccessKey)) errors.push("Chave de acesso da nota fiscal não pode conter letras");
    if (invoiceAccessKey.length !== 44) errors.push("Chave de acesso da nota fiscal precisa ter 44 caracteres");
  }

  return {
    line: lineNumber,
    recipient,
    parcel,
    goodsValue: numOrZero(raw, COLUMNS.GOODS_VALUE),
    declaredValue: numOrZero(raw, COLUMNS.DECLARED_VALUE),
    invoiceNumber: text(raw, COLUMNS.INVOICE_NUMBER),
    invoiceAccessKey,
    withDeliveryReceipt: rawDeliveryReceipt === "S" || rawDeliveryReceipt === "SIM",
    senderReference: text(raw, COLUMNS.SENDER_REFERENCE).toUpperCase(),
    errors,
  };
}

// Re-exported so callers that only need digits (e.g. building a quote key) do not
// have to reach into the text module.
export { digitsOnly };
