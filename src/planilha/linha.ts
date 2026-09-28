// Maps one raw spreadsheet row onto the normalized shape the log persists, and
// reports the row-level problems the log would have reported for it.
//
// Only the checks that can be answered from the row itself live here: required
// fields, formats and check digits. The ones that need the client's registration
// or an external service — the sender's data, the CEP lookup at Correios, the
// state registration (IE), the declared-value ceiling per carrier modality —
// stay in the log, which already has that context.

import {
  formataCep,
  formataCpfCnpj,
  formataTelefone,
  separaEndereco,
  somenteNumeros,
  substituiAcentos,
  validaCpfCnpj,
} from "./texto";

export interface Destinatario {
  nome: string;
  logradouro: string;
  endereco: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
  cep: string;
  cpfCnpj: string;
  rgIe: string;
  telefone: string;
  email: string;
}

export interface Objeto {
  pesoKg: number;
  alturaCm: number;
  larguraCm: number;
  comprimentoCm: number;
  diametroCm: number;
}

export interface LinhaPlanilha {
  // 1-based position in the sheet, header included, so an error message can point
  // the user at the line they need to fix.
  linha: number;
  destinatario: Destinatario;
  objeto: Objeto;
  valorMercadoria: number;
  valorDeclarado: number;
  numeroNf: string;
  chaveAcessoNf: string;
  comAr: boolean;
  controleRemetente: string;
  erros: string[];
}

// Column order of the "Modelo - Padrao" sheet (layout 1), which is what the log
// reads by numeric index. Named here so a column move is a one-line change.
export const COLUNAS = {
  NOME: 0,
  LOGRADOURO: 1,
  NUMERO: 2,
  COMPLEMENTO: 3,
  BAIRRO: 4,
  CIDADE: 5,
  UF: 6,
  CEP: 7,
  CPFCNPJ: 8,
  RGIE: 9,
  TELEFONE: 10,
  EMAIL: 11,
  PESO_KG: 12,
  ALTURA_CM: 13,
  LARGURA_CM: 14,
  COMPRIMENTO_CM: 15,
  DIAMETRO_CM: 16,
  VALOR_MERCADORIA: 17,
  VALOR_DECLARADO: 18,
  NUMERO_NF: 19,
  CHAVEACESSO_NF: 20,
  COM_AR: 21,
  CONTROLE_REMETENTE: 22,
} as const;

// A cell as a trimmed string. A short row (Excel drops trailing empty cells)
// reads as empty rather than blowing up.
function texto(bruta: unknown[], coluna: number): string {
  const valor = bruta[coluna];
  if (valor === null || valor === undefined) return "";

  return String(valor).trim();
}

// A numeric cell. Excel hands numbers over as numbers, but a sheet typed by hand
// often carries them as text in the Brazilian format ("1.250,50") — both read the
// same way here. The dot only counts as a thousands separator when a comma is
// present, otherwise it is the decimal point of a plain number. An empty cell is
// NaN so the caller can tell "empty" from "zero", which the log's own validation
// also distinguishes.
function numero(bruta: unknown[], coluna: number): number {
  const valor = texto(bruta, coluna);
  if (valor === "") return NaN;

  const normalizado = valor.includes(",") ? valor.replace(/\./g, "").replace(",", ".") : valor;

  return Number(normalizado);
}

// A numeric cell that is optional: an empty or unreadable value counts as zero,
// like the log does for the merchandise and declared values.
function numeroOuZero(bruta: unknown[], coluna: number): number {
  const valor = numero(bruta, coluna);
  return Number.isNaN(valor) ? 0 : valor;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function mapearLinha(bruta: unknown[], numeroLinha: number): LinhaPlanilha {
  const erros: string[] = [];

  // The sheet carries the street type and the street name in one cell. The log
  // splits them on the first space, strips accents only from the street name, and
  // falls back to "RUA" / a single space when either side comes out empty.
  const enderecoBruto = texto(bruta, COLUNAS.LOGRADOURO);
  const logradouro = separaEndereco(enderecoBruto).logradouro.trim() || "RUA";
  const endereco = separaEndereco(substituiAcentos(enderecoBruto)).endereco.trim() || " ";

  const cepBruto = texto(bruta, COLUNAS.CEP);
  const cep = formataCep(cepBruto);

  const cpfCnpjBruto = texto(bruta, COLUNAS.CPFCNPJ);
  const cpfCnpj = formataCpfCnpj(cpfCnpjBruto);

  const email = texto(bruta, COLUNAS.EMAIL).toLowerCase();

  const destinatario: Destinatario = {
    nome: substituiAcentos(texto(bruta, COLUNAS.NOME)),
    logradouro,
    endereco,
    numero: texto(bruta, COLUNAS.NUMERO),
    complemento: substituiAcentos(texto(bruta, COLUNAS.COMPLEMENTO)),
    bairro: substituiAcentos(texto(bruta, COLUNAS.BAIRRO)),
    cidade: substituiAcentos(texto(bruta, COLUNAS.CIDADE)),
    uf: texto(bruta, COLUNAS.UF).toUpperCase(),
    cep: cep ?? "",
    cpfCnpj: cpfCnpj ?? "",
    rgIe: texto(bruta, COLUNAS.RGIE),
    telefone: formataTelefone(texto(bruta, COLUNAS.TELEFONE)),
    email,
  };

  const objeto: Objeto = {
    pesoKg: numeroOuZero(bruta, COLUNAS.PESO_KG),
    alturaCm: numeroOuZero(bruta, COLUNAS.ALTURA_CM),
    larguraCm: numeroOuZero(bruta, COLUNAS.LARGURA_CM),
    comprimentoCm: numeroOuZero(bruta, COLUNAS.COMPRIMENTO_CM),
    diametroCm: numeroOuZero(bruta, COLUNAS.DIAMETRO_CM),
  };

  const chaveAcessoNf = texto(bruta, COLUNAS.CHAVEACESSO_NF);
  const comArBruto = texto(bruta, COLUNAS.COM_AR).toUpperCase();

  // ── Row-level validation, in the log's own wording ──────────────────────
  if (destinatario.nome === "") erros.push("Nome do destinatário não pode ser vazio");
  if (destinatario.numero === "") erros.push("Número do endereço do destinatário não pode ser vazio");
  if (destinatario.bairro === "") erros.push("Bairro do destinatário não pode ser vazio");
  if (destinatario.cidade === "") erros.push("Cidade do destinatário não pode ser vazio");
  if (destinatario.uf === "") erros.push("UF do destinatário não pode ser vazio");

  if (cepBruto === "") {
    erros.push("CEP do destinatário não pode ser vazio");
  } else if (cep === null) {
    erros.push("CEP do destinatário inválido");
  }

  if (cpfCnpjBruto === "") {
    erros.push("CPF/CNPJ do destinatário não pode ser vazio");
  } else if (!validaCpfCnpj(cpfCnpjBruto)) {
    erros.push("CPF/CNPJ do destinatário inválido");
  }

  if (email !== "" && !EMAIL.test(email)) erros.push("Email do destinatário inválido");

  if (Number.isNaN(numero(bruta, COLUNAS.PESO_KG))) erros.push("O peso do objeto não pode ser vazio");
  if (Number.isNaN(numero(bruta, COLUNAS.ALTURA_CM))) erros.push("Altura do objeto não pode ser vazia");
  if (Number.isNaN(numero(bruta, COLUNAS.LARGURA_CM))) erros.push("Largura do objeto não pode ser vazia");
  if (Number.isNaN(numero(bruta, COLUNAS.COMPRIMENTO_CM))) erros.push("Profundidade do objeto não pode ser vazia");

  if (chaveAcessoNf !== "") {
    if (/[a-z]/i.test(chaveAcessoNf)) erros.push("Chave de acesso da nota fiscal não pode conter letras");
    if (chaveAcessoNf.length !== 44) erros.push("Chave de acesso da nota fiscal precisa ter 44 caracteres");
  }

  return {
    linha: numeroLinha,
    destinatario,
    objeto,
    valorMercadoria: numeroOuZero(bruta, COLUNAS.VALOR_MERCADORIA),
    valorDeclarado: numeroOuZero(bruta, COLUNAS.VALOR_DECLARADO),
    numeroNf: texto(bruta, COLUNAS.NUMERO_NF),
    chaveAcessoNf,
    comAr: comArBruto === "S" || comArBruto === "SIM",
    controleRemetente: texto(bruta, COLUNAS.CONTROLE_REMETENTE).toUpperCase(),
    erros,
  };
}

// Re-exported so callers that only need digits (e.g. building a quote key) do not
// have to reach into the text module.
export { somenteNumeros };
