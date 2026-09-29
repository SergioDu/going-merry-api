// Field-level formatting, ported from the log project so a row this API returns
// is byte-identical to the one the log's own importer would have produced for the
// same spreadsheet cell. Each function below names the fwBase method it mirrors —
// when one of them changes in the log, change it here too.

// fwBase::substituiAcentos. Strips accents, drops the punctuation the log drops
// (\ ' " / º ª), turns commas and colons into spaces, normalizes dashes and line
// breaks, then removes tabs and trims.
const ACCENTED = "àáâãäåçèéêëìíîïñòóôõöùüúÿÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÜÚ";
const UNACCENTED = "aaaaaaceeeeiiiinooooouuuyAAAAAACEEEEIIIINOOOOOUUU";

export function stripAccents(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";

  let out = "";
  for (const char of String(value)) {
    const index = ACCENTED.indexOf(char);
    if (index >= 0) {
      out += UNACCENTED[index];
      continue;
    }

    // Removed outright by the log.
    if (char === "\\" || char === "'" || char === '"' || char === "/" || char === "º" || char === "ª") continue;
    // Replaced by a space.
    if (char === "," || char === ":" || char === "\n" || char === "\r") {
      out += " ";
      continue;
    }
    // En dash becomes a plain hyphen.
    if (char === "–") {
      out += "-";
      continue;
    }

    out += char;
  }

  return out.replace(/\t+/g, "").trim();
}

// fwBase::SeparaEndereco. The sheet carries street type and street name in one
// cell ("PRAÇA DA SÉ"); the log stores them apart, taking the first word as the
// type. A single-word cell leaves the street name empty.
export function splitAddress(address: string): { streetType: string; street: string } {
  const text = address ?? "";
  const separator = text.indexOf(" ");

  if (separator < 0) return { streetType: text, street: "" };

  return { streetType: text.slice(0, separator), street: text.slice(separator + 1) };
}

// fwBase::RemovePontuacaoNumero.
export function digitsOnly(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[^0-9]/g, "");
}

// fwBase::FormataCEPOnlog($cep, true). Returns null instead of throwing — the
// caller turns that into the row's "CEP inválido" error.
export function formatPostalCode(postalCode: string | null | undefined): string | null {
  const digits = digitsOnly(postalCode);
  if (digits.length !== 8) return null;

  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

// fwBase::FormataCpfCnpj. An empty cell stays empty (the row validation reports
// it); a wrong length is null, which the log treats as invalid.
export function formatTaxId(taxId: string | null | undefined): string | null {
  const digits = digitsOnly(taxId);
  if (digits.length === 0) return "";

  if (digits.length === 11) {
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
  }

  if (digits.length === 14) {
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
  }

  return null;
}

// fwBase::FormataTelefone. Anything that is not a 10 or 11 digit number is
// discarded rather than reported — same as the log.
export function formatPhone(phone: string | null | undefined): string {
  const digits = digitsOnly(phone);

  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }

  if (digits.length === 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }

  return "";
}

// The shared digit-and-position sum behind both check digits, as fwValidaCPFCNPJ
// implements it: multiply each digit by a descending position that wraps back to
// 9 once it drops below 2, then take 11 minus the remainder mod 11 (0 when that
// remainder is under 2).
function appendCheckDigit(digits: string, startPosition: number): string {
  let position = startPosition;
  let sum = 0;

  for (const digit of digits) {
    sum += Number(digit) * position;
    position--;
    if (position < 2) position = 9;
  }

  const remainder = sum % 11;

  return digits + String(remainder < 2 ? 0 : 11 - remainder);
}

// fwValidaCPFCNPJ::valida. Checks the verifying digits and rejects a string of
// one repeated digit (11111111111), which the check digits alone would accept.
export function isValidTaxId(value: string | null | undefined): boolean {
  const digits = digitsOnly(value);

  if (digits.length === 11) {
    if (/^(\d)\1+$/.test(digits)) return false;
    return appendCheckDigit(appendCheckDigit(digits.slice(0, 9), 10), 11) === digits;
  }

  if (digits.length === 14) {
    if (/^(\d)\1+$/.test(digits)) return false;
    return appendCheckDigit(appendCheckDigit(digits.slice(0, 12), 5), 6) === digits;
  }

  return false;
}
