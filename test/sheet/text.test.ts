import { describe, expect, it } from "vitest";

import {
  digitsOnly,
  formatPhone,
  formatPostalCode,
  formatTaxId,
  isValidTaxId,
  splitAddress,
  stripAccents,
} from "../../src/sheet/text";

// These helpers are a port of fwBase's own formatting methods in the log project
// (substituiAcentos, SeparaEndereco, FormataCEPOnlog, FormataCpfCnpj,
// FormataTelefone) plus fwValidaCPFCNPJ. The spreadsheet rows they normalize end
// up in the same temp table as the ones the log builds itself, so a difference
// here would show up as two different shipments for the same sheet.

describe("stripAccents", () => {
  it("strips accents the same way the log does before persisting a name", () => {
    expect(stripAccents("JOSÉ DA SILVA JÚNIOR")).toBe("JOSE DA SILVA JUNIOR");
    expect(stripAccents("praça são joão")).toBe("praca sao joao");
  });

  it("drops the punctuation the log drops and turns commas into spaces", () => {
    expect(stripAccents('RUA A / B \\ C "D"')).toBe("RUA A  B  C D");
    expect(stripAccents("APTO 12, BLOCO B")).toBe("APTO 12  BLOCO B");
    expect(stripAccents("1º ANDAR")).toBe("1 ANDAR");
  });

  it("collapses line breaks and tabs and trims the result", () => {
    expect(stripAccents("  RUA A\n\tB  ")).toBe("RUA A B");
  });

  it("treats an empty cell as an empty string", () => {
    expect(stripAccents(null)).toBe("");
    expect(stripAccents(undefined)).toBe("");
  });
});

describe("splitAddress", () => {
  it("splits the first word off as the street type", () => {
    expect(splitAddress("PRAÇA DA SÉ")).toEqual({ streetType: "PRAÇA", street: "DA SÉ" });
    expect(splitAddress("RUA DAS FLORES")).toEqual({ streetType: "RUA", street: "DAS FLORES" });
  });

  it("leaves the street empty when there is a single word, like the log does", () => {
    expect(splitAddress("RUA")).toEqual({ streetType: "RUA", street: "" });
  });
});

describe("formatPostalCode", () => {
  it("formats eight digits as 00000-000 regardless of how they were typed", () => {
    expect(formatPostalCode("01001000")).toBe("01001-000");
    expect(formatPostalCode("01001-000")).toBe("01001-000");
    expect(formatPostalCode(" 01.001-000 ")).toBe("01001-000");
  });

  it("returns null for anything that is not eight digits", () => {
    expect(formatPostalCode("123")).toBeNull();
    expect(formatPostalCode("")).toBeNull();
    expect(formatPostalCode("010010000")).toBeNull();
  });
});

describe("formatTaxId", () => {
  it("masks 11 digits as a CPF and 14 as a CNPJ", () => {
    expect(formatTaxId("11122233344")).toBe("111.222.333-44");
    expect(formatTaxId("11222333444455")).toBe("11.222.333/4444-55");
  });

  it("returns an empty string for an empty cell and null for a wrong length", () => {
    expect(formatTaxId("")).toBe("");
    expect(formatTaxId("123")).toBeNull();
  });
});

describe("formatPhone", () => {
  it("masks 11 and 10 digit numbers", () => {
    expect(formatPhone("11999998888")).toBe("(11) 99999-8888");
    expect(formatPhone("1133334444")).toBe("(11) 3333-4444");
  });

  it("returns an empty string for any other length, like the log does", () => {
    expect(formatPhone("999998888")).toBe("");
    expect(formatPhone("")).toBe("");
  });
});

describe("digitsOnly", () => {
  it("keeps digits only", () => {
    expect(digitsOnly("111.222.333-44")).toBe("11122233344");
    expect(digitsOnly("")).toBe("");
  });
});

describe("isValidTaxId", () => {
  it("accepts valid check digits", () => {
    expect(isValidTaxId("529.982.247-25")).toBe(true);
    expect(isValidTaxId("11.222.333/0001-81")).toBe(true);
  });

  it("rejects wrong check digits, repeated digits and wrong lengths", () => {
    expect(isValidTaxId("529.982.247-24")).toBe(false);
    expect(isValidTaxId("111.111.111-11")).toBe(false);
    expect(isValidTaxId("11111111111111")).toBe(false);
    expect(isValidTaxId("123")).toBe(false);
    expect(isValidTaxId("")).toBe(false);
  });
});
