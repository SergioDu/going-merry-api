// Field-level formatting, ported from the log project so a row this API returns
// is byte-identical to the one the log's own importer would have produced for the
// same spreadsheet cell. Each function below names the fwBase method it mirrors —
// when one of them changes in the log, change it here too.

// fwBase::substituiAcentos. Strips accents, drops the punctuation the log drops
// (\ ' " / º ª), turns commas and colons into spaces, normalizes dashes and line
// breaks, then removes tabs and trims.
const COM_ACENTOS = "àáâãäåçèéêëìíîïñòóôõöùüúÿÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÜÚ";
const SEM_ACENTOS = "aaaaaaceeeeiiiinooooouuuyAAAAAACEEEEIIIINOOOOOUUU";

export function substituiAcentos(valor: string | null | undefined): string {
  if (valor === null || valor === undefined) return "";

  let saida = "";
  for (const char of String(valor)) {
    const indice = COM_ACENTOS.indexOf(char);
    if (indice >= 0) {
      saida += SEM_ACENTOS[indice];
      continue;
    }

    // Removed outright by the log.
    if (char === "\\" || char === "'" || char === '"' || char === "/" || char === "º" || char === "ª") continue;
    // Replaced by a space.
    if (char === "," || char === ":" || char === "\n" || char === "\r") {
      saida += " ";
      continue;
    }
    // En dash becomes a plain hyphen.
    if (char === "–") {
      saida += "-";
      continue;
    }

    saida += char;
  }

  return saida.replace(/\t+/g, "").trim();
}

// fwBase::SeparaEndereco. The sheet carries street type and street name in one
// cell ("PRAÇA DA SÉ"); the log stores them apart, taking the first word as the
// type. A single-word cell leaves the street name empty.
export function separaEndereco(endereco: string): { logradouro: string; endereco: string } {
  const texto = endereco ?? "";
  const separador = texto.indexOf(" ");

  if (separador < 0) return { logradouro: texto, endereco: "" };

  return { logradouro: texto.slice(0, separador), endereco: texto.slice(separador + 1) };
}

// fwBase::RemovePontuacaoNumero.
export function somenteNumeros(valor: string | null | undefined): string {
  if (valor === null || valor === undefined) return "";
  return String(valor).replace(/[^0-9]/g, "");
}

// fwBase::FormataCEPOnlog($cep, true). Returns null instead of throwing — the
// caller turns that into the row's "CEP inválido" error.
export function formataCep(cep: string | null | undefined): string | null {
  const digitos = somenteNumeros(cep);
  if (digitos.length !== 8) return null;

  return `${digitos.slice(0, 5)}-${digitos.slice(5)}`;
}

// fwBase::FormataCpfCnpj. An empty cell stays empty (the row validation reports
// it); a wrong length is null, which the log treats as invalid.
export function formataCpfCnpj(cpfCnpj: string | null | undefined): string | null {
  const digitos = somenteNumeros(cpfCnpj);
  if (digitos.length === 0) return "";

  if (digitos.length === 11) {
    return `${digitos.slice(0, 3)}.${digitos.slice(3, 6)}.${digitos.slice(6, 9)}-${digitos.slice(9)}`;
  }

  if (digitos.length === 14) {
    return `${digitos.slice(0, 2)}.${digitos.slice(2, 5)}.${digitos.slice(5, 8)}/${digitos.slice(8, 12)}-${digitos.slice(12)}`;
  }

  return null;
}

// fwBase::FormataTelefone. Anything that is not a 10 or 11 digit number is
// discarded rather than reported — same as the log.
export function formataTelefone(telefone: string | null | undefined): string {
  const digitos = somenteNumeros(telefone);

  if (digitos.length === 11) {
    return `(${digitos.slice(0, 2)}) ${digitos.slice(2, 7)}-${digitos.slice(7)}`;
  }

  if (digitos.length === 10) {
    return `(${digitos.slice(0, 2)}) ${digitos.slice(2, 6)}-${digitos.slice(6)}`;
  }

  return "";
}

// The shared digit-and-position sum behind both check digits, as fwValidaCPFCNPJ
// implements it: multiply each digit by a descending position that wraps back to
// 9 once it drops below 2, then take 11 minus the remainder mod 11 (0 when that
// remainder is under 2).
function calculaDigito(digitos: string, posicaoInicial: number): string {
  let posicoes = posicaoInicial;
  let soma = 0;

  for (const digito of digitos) {
    soma += Number(digito) * posicoes;
    posicoes--;
    if (posicoes < 2) posicoes = 9;
  }

  const resto = soma % 11;

  return digitos + String(resto < 2 ? 0 : 11 - resto);
}

// fwValidaCPFCNPJ::valida. Checks the verifying digits and rejects a string of
// one repeated digit (11111111111), which the check digits alone would accept.
export function validaCpfCnpj(valor: string | null | undefined): boolean {
  const digitos = somenteNumeros(valor);

  if (digitos.length === 11) {
    if (/^(\d)\1+$/.test(digitos)) return false;
    return calculaDigito(calculaDigito(digitos.slice(0, 9), 10), 11) === digitos;
  }

  if (digitos.length === 14) {
    if (/^(\d)\1+$/.test(digitos)) return false;
    return calculaDigito(calculaDigito(digitos.slice(0, 12), 5), 6) === digitos;
  }

  return false;
}
