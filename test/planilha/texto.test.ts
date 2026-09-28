import { describe, expect, it } from "vitest";

import {
  formataCep,
  formataCpfCnpj,
  formataTelefone,
  separaEndereco,
  somenteNumeros,
  substituiAcentos,
  validaCpfCnpj,
} from "../../src/planilha/texto";

// These helpers are a port of fwBase's own formatting methods in the log project
// (substituiAcentos, SeparaEndereco, FormataCEPOnlog, FormataCpfCnpj,
// FormataTelefone) plus fwValidaCPFCNPJ. The spreadsheet rows they normalize end
// up in the same temp table as the ones the log builds itself, so a difference
// here would show up as two different shipments for the same sheet.

describe("substituiAcentos", () => {
  it("strips accents the same way the log does before persisting a name", () => {
    expect(substituiAcentos("JOSÉ DA SILVA JÚNIOR")).toBe("JOSE DA SILVA JUNIOR");
    expect(substituiAcentos("praça são joão")).toBe("praca sao joao");
  });

  it("drops the punctuation the log drops and turns commas into spaces", () => {
    expect(substituiAcentos('RUA A / B \\ C "D"')).toBe("RUA A  B  C D");
    expect(substituiAcentos("APTO 12, BLOCO B")).toBe("APTO 12  BLOCO B");
    expect(substituiAcentos("1º ANDAR")).toBe("1 ANDAR");
  });

  it("collapses line breaks and tabs and trims the result", () => {
    expect(substituiAcentos("  RUA A\n\tB  ")).toBe("RUA A B");
  });

  it("treats an empty cell as an empty string", () => {
    expect(substituiAcentos(null)).toBe("");
    expect(substituiAcentos(undefined)).toBe("");
  });
});

describe("separaEndereco", () => {
  it("splits the first word off as the logradouro type", () => {
    expect(separaEndereco("PRAÇA DA SÉ")).toEqual({ logradouro: "PRAÇA", endereco: "DA SÉ" });
    expect(separaEndereco("RUA DAS FLORES")).toEqual({ logradouro: "RUA", endereco: "DAS FLORES" });
  });

  it("leaves the endereco empty when there is a single word, like the log does", () => {
    expect(separaEndereco("RUA")).toEqual({ logradouro: "RUA", endereco: "" });
  });
});

describe("formataCep", () => {
  it("formats eight digits as 00000-000 regardless of how they were typed", () => {
    expect(formataCep("01001000")).toBe("01001-000");
    expect(formataCep("01001-000")).toBe("01001-000");
    expect(formataCep(" 01.001-000 ")).toBe("01001-000");
  });

  it("returns null for anything that is not eight digits", () => {
    expect(formataCep("123")).toBeNull();
    expect(formataCep("")).toBeNull();
    expect(formataCep("010010000")).toBeNull();
  });
});

describe("formataCpfCnpj", () => {
  it("masks 11 digits as a CPF and 14 as a CNPJ", () => {
    expect(formataCpfCnpj("11122233344")).toBe("111.222.333-44");
    expect(formataCpfCnpj("11222333444455")).toBe("11.222.333/4444-55");
  });

  it("returns an empty string for an empty cell and null for a wrong length", () => {
    expect(formataCpfCnpj("")).toBe("");
    expect(formataCpfCnpj("123")).toBeNull();
  });
});

describe("formataTelefone", () => {
  it("masks 11 and 10 digit numbers", () => {
    expect(formataTelefone("11999998888")).toBe("(11) 99999-8888");
    expect(formataTelefone("1133334444")).toBe("(11) 3333-4444");
  });

  it("returns an empty string for any other length, like the log does", () => {
    expect(formataTelefone("999998888")).toBe("");
    expect(formataTelefone("")).toBe("");
  });
});

describe("somenteNumeros", () => {
  it("keeps digits only", () => {
    expect(somenteNumeros("111.222.333-44")).toBe("11122233344");
    expect(somenteNumeros("")).toBe("");
  });
});

describe("validaCpfCnpj", () => {
  it("accepts valid check digits", () => {
    expect(validaCpfCnpj("529.982.247-25")).toBe(true);
    expect(validaCpfCnpj("11.222.333/0001-81")).toBe(true);
  });

  it("rejects wrong check digits, repeated digits and wrong lengths", () => {
    expect(validaCpfCnpj("529.982.247-24")).toBe(false);
    expect(validaCpfCnpj("111.111.111-11")).toBe(false);
    expect(validaCpfCnpj("11111111111111")).toBe(false);
    expect(validaCpfCnpj("123")).toBe(false);
    expect(validaCpfCnpj("")).toBe(false);
  });
});
