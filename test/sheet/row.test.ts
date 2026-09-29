import { describe, expect, it } from "vitest";

import { mapRow } from "../../src/sheet/row";

// A complete row of the "Modelo - Padrao" sheet, in the column order the log
// reads (DESTINATARIO_NOME … CONTROLE_REMETENTE). Tests override single cells to
// isolate one rule at a time.
function rawRow(overrides: Record<number, unknown> = {}): unknown[] {
  const raw: unknown[] = [
    "NOME DESTINATÁRIO 1", // 0  DESTINATARIO_NOME
    "PRAÇA DA SÉ", // 1  DESTINATARIO_LOGRADOURO
    "12", // 2  DESTINATARIO_NUMERO
    "APTO 3", // 3  DESTINATARIO_COMPL
    "SÉ", // 4  DESTINATARIO_BAIRRO
    "SÃO PAULO", // 5  DESTINATARIO_CIDADE
    "SP", // 6  DESTINATARIO_UF
    "01001-000", // 7  DESTINATARIO_CEP
    "529.982.247-25", // 8  DESTINATARIO_CPFCNPJ
    "", // 9  DESTINATARIO_RGIE
    "11999998888", // 10 DESTINATARIO_TELEFONE
    "Contato@Email.com", // 11 DESTINATARIO_EMAIL
    1, // 12 OBJETO_PESO_KG
    10, // 13 OBJETO_ALTURA_CM
    20, // 14 OBJETO_LARGURA_CM
    30, // 15 OBJETO_COMPRIMENTO_CM
    0, // 16 OBJETO_DIAMETRO_CM
    150.5, // 17 VALOR_MERCADORIA
    60, // 18 VALOR_DECLARADO
    "123", // 19 NUMERO_NF
    "", // 20 CHAVEACESSO_NF
    "S", // 21 COM_AR
    "pedido-1", // 22 CONTROLE_REMETENTE
  ];

  for (const [index, value] of Object.entries(overrides)) {
    raw[Number(index)] = value;
  }

  return raw;
}

describe("mapRow — normalization", () => {
  it("maps every column of a complete row and reports no errors", () => {
    const row = mapRow(rawRow(), 2);

    expect(row.errors).toEqual([]);
    expect(row.line).toBe(2);
    expect(row.recipient).toEqual({
      name: "NOME DESTINATARIO 1",
      // The log splits the street cell in two and strips accents only from the
      // street name, so the type keeps its cedilla.
      streetType: "PRAÇA",
      street: "DA SE",
      number: "12",
      complement: "APTO 3",
      district: "SE",
      city: "SAO PAULO",
      state: "SP",
      postalCode: "01001-000",
      taxId: "529.982.247-25",
      stateRegistration: "",
      phone: "(11) 99999-8888",
      email: "contato@email.com",
    });
    expect(row.parcel).toEqual({ weightKg: 1, heightCm: 10, widthCm: 20, lengthCm: 30, diameterCm: 0 });
    expect(row.goodsValue).toBe(150.5);
    expect(row.declaredValue).toBe(60);
    expect(row.invoiceNumber).toBe("123");
    expect(row.invoiceAccessKey).toBe("");
    expect(row.withDeliveryReceipt).toBe(true);
    expect(row.senderReference).toBe("PEDIDO-1");
  });

  it("defaults the street type to RUA when the address cell is a single word", () => {
    const row = mapRow(rawRow({ 1: "AVENIDA" }), 2);

    expect(row.recipient.streetType).toBe("AVENIDA");
    // The log keeps a single blank space rather than an empty street name.
    expect(row.recipient.street).toBe(" ");
  });

  it("reads COM_AR as true only for S or SIM, in any case", () => {
    expect(mapRow(rawRow({ 21: "sim" }), 2).withDeliveryReceipt).toBe(true);
    expect(mapRow(rawRow({ 21: "s" }), 2).withDeliveryReceipt).toBe(true);
    expect(mapRow(rawRow({ 21: "N" }), 2).withDeliveryReceipt).toBe(false);
    expect(mapRow(rawRow({ 21: "" }), 2).withDeliveryReceipt).toBe(false);
  });

  it("treats missing trailing columns as empty instead of failing", () => {
    const short = rawRow().slice(0, 19);
    const row = mapRow(short, 2);

    expect(row.invoiceNumber).toBe("");
    expect(row.invoiceAccessKey).toBe("");
    expect(row.withDeliveryReceipt).toBe(false);
    expect(row.senderReference).toBe("");
    expect(row.errors).toEqual([]);
  });

  it("accepts numbers written as text with a comma, as Excel hands them over", () => {
    const row = mapRow(rawRow({ 12: "1,250", 17: "150,50" }), 2);

    expect(row.parcel.weightKg).toBe(1.25);
    expect(row.goodsValue).toBe(150.5);
  });

  it("zeroes the declared and merchandise values when the cells are blank", () => {
    const row = mapRow(rawRow({ 17: "", 18: null }), 2);

    expect(row.goodsValue).toBe(0);
    expect(row.declaredValue).toBe(0);
  });
});

describe("mapRow — row validation", () => {
  it("reports every required destination field that is empty", () => {
    const row = mapRow(rawRow({ 0: "", 2: "", 4: "", 5: "", 6: "", 7: "" }), 2);

    expect(row.errors).toContain("Nome do destinatário não pode ser vazio");
    expect(row.errors).toContain("Número do endereço do destinatário não pode ser vazio");
    expect(row.errors).toContain("Bairro do destinatário não pode ser vazio");
    expect(row.errors).toContain("Cidade do destinatário não pode ser vazio");
    expect(row.errors).toContain("UF do destinatário não pode ser vazio");
    expect(row.errors).toContain("CEP do destinatário não pode ser vazio");
  });

  it("reports a CEP that is present but not eight digits", () => {
    const row = mapRow(rawRow({ 7: "0100-10" }), 2);

    expect(row.errors).toContain("CEP do destinatário inválido");
    expect(row.recipient.postalCode).toBe("");
  });

  it("reports an empty CPF/CNPJ apart from an invalid one", () => {
    expect(mapRow(rawRow({ 8: "" }), 2).errors).toContain("CPF/CNPJ do destinatário não pode ser vazio");
    expect(mapRow(rawRow({ 8: "529.982.247-24" }), 2).errors).toContain("CPF/CNPJ do destinatário inválido");
  });

  it("reports an invalid email but accepts an empty one", () => {
    expect(mapRow(rawRow({ 11: "nao-e-email" }), 2).errors).toContain("Email do destinatário inválido");
    expect(mapRow(rawRow({ 11: "" }), 2).errors).toEqual([]);
  });

  it("reports missing package dimensions and weight", () => {
    const row = mapRow(rawRow({ 12: "", 13: "", 14: "", 15: "" }), 2);

    expect(row.errors).toContain("O peso do objeto não pode ser vazio");
    expect(row.errors).toContain("Altura do objeto não pode ser vazia");
    expect(row.errors).toContain("Largura do objeto não pode ser vazia");
    expect(row.errors).toContain("Profundidade do objeto não pode ser vazia");
  });

  it("accepts a zero dimension, which is not the same as an empty one", () => {
    expect(mapRow(rawRow({ 16: 0 }), 2).errors).toEqual([]);
  });

  it("checks the NFe access key only when one was typed", () => {
    expect(mapRow(rawRow({ 20: "" }), 2).errors).toEqual([]);
    expect(mapRow(rawRow({ 20: "1234" }), 2).errors).toContain(
      "Chave de acesso da nota fiscal precisa ter 44 caracteres",
    );
    expect(mapRow(rawRow({ 20: "A".repeat(44) }), 2).errors).toContain(
      "Chave de acesso da nota fiscal não pode conter letras",
    );
    expect(mapRow(rawRow({ 20: "1".repeat(44) }), 2).errors).toEqual([]);
  });
});
