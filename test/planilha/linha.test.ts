import { describe, expect, it } from "vitest";

import { mapearLinha } from "../../src/planilha/linha";

// A complete row of the "Modelo - Padrao" sheet, in the column order the log
// reads (DESTINATARIO_NOME … CONTROLE_REMETENTE). Tests override single cells to
// isolate one rule at a time.
function linhaBruta(sobrescreve: Record<number, unknown> = {}): unknown[] {
  const bruta: unknown[] = [
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

  for (const [indice, valor] of Object.entries(sobrescreve)) {
    bruta[Number(indice)] = valor;
  }

  return bruta;
}

describe("mapearLinha — normalization", () => {
  it("maps every column of a complete row and reports no errors", () => {
    const linha = mapearLinha(linhaBruta(), 2);

    expect(linha.erros).toEqual([]);
    expect(linha.linha).toBe(2);
    expect(linha.destinatario).toEqual({
      nome: "NOME DESTINATARIO 1",
      // The log splits the street cell in two and strips accents only from the
      // street name, so the type keeps its cedilla.
      logradouro: "PRAÇA",
      endereco: "DA SE",
      numero: "12",
      complemento: "APTO 3",
      bairro: "SE",
      cidade: "SAO PAULO",
      uf: "SP",
      cep: "01001-000",
      cpfCnpj: "529.982.247-25",
      rgIe: "",
      telefone: "(11) 99999-8888",
      email: "contato@email.com",
    });
    expect(linha.objeto).toEqual({ pesoKg: 1, alturaCm: 10, larguraCm: 20, comprimentoCm: 30, diametroCm: 0 });
    expect(linha.valorMercadoria).toBe(150.5);
    expect(linha.valorDeclarado).toBe(60);
    expect(linha.numeroNf).toBe("123");
    expect(linha.chaveAcessoNf).toBe("");
    expect(linha.comAr).toBe(true);
    expect(linha.controleRemetente).toBe("PEDIDO-1");
  });

  it("defaults the street type to RUA when the address cell is a single word", () => {
    const linha = mapearLinha(linhaBruta({ 1: "AVENIDA" }), 2);

    expect(linha.destinatario.logradouro).toBe("AVENIDA");
    // The log keeps a single blank space rather than an empty street name.
    expect(linha.destinatario.endereco).toBe(" ");
  });

  it("reads COM_AR as true only for S or SIM, in any case", () => {
    expect(mapearLinha(linhaBruta({ 21: "sim" }), 2).comAr).toBe(true);
    expect(mapearLinha(linhaBruta({ 21: "s" }), 2).comAr).toBe(true);
    expect(mapearLinha(linhaBruta({ 21: "N" }), 2).comAr).toBe(false);
    expect(mapearLinha(linhaBruta({ 21: "" }), 2).comAr).toBe(false);
  });

  it("treats missing trailing columns as empty instead of failing", () => {
    const curta = linhaBruta().slice(0, 19);
    const linha = mapearLinha(curta, 2);

    expect(linha.numeroNf).toBe("");
    expect(linha.chaveAcessoNf).toBe("");
    expect(linha.comAr).toBe(false);
    expect(linha.controleRemetente).toBe("");
    expect(linha.erros).toEqual([]);
  });

  it("accepts numbers written as text with a comma, as Excel hands them over", () => {
    const linha = mapearLinha(linhaBruta({ 12: "1,250", 17: "150,50" }), 2);

    expect(linha.objeto.pesoKg).toBe(1.25);
    expect(linha.valorMercadoria).toBe(150.5);
  });

  it("zeroes the declared and merchandise values when the cells are blank", () => {
    const linha = mapearLinha(linhaBruta({ 17: "", 18: null }), 2);

    expect(linha.valorMercadoria).toBe(0);
    expect(linha.valorDeclarado).toBe(0);
  });
});

describe("mapearLinha — row validation", () => {
  it("reports every required destination field that is empty", () => {
    const linha = mapearLinha(linhaBruta({ 0: "", 2: "", 4: "", 5: "", 6: "", 7: "" }), 2);

    expect(linha.erros).toContain("Nome do destinatário não pode ser vazio");
    expect(linha.erros).toContain("Número do endereço do destinatário não pode ser vazio");
    expect(linha.erros).toContain("Bairro do destinatário não pode ser vazio");
    expect(linha.erros).toContain("Cidade do destinatário não pode ser vazio");
    expect(linha.erros).toContain("UF do destinatário não pode ser vazio");
    expect(linha.erros).toContain("CEP do destinatário não pode ser vazio");
  });

  it("reports a CEP that is present but not eight digits", () => {
    const linha = mapearLinha(linhaBruta({ 7: "0100-10" }), 2);

    expect(linha.erros).toContain("CEP do destinatário inválido");
    expect(linha.destinatario.cep).toBe("");
  });

  it("reports an empty CPF/CNPJ apart from an invalid one", () => {
    expect(mapearLinha(linhaBruta({ 8: "" }), 2).erros).toContain("CPF/CNPJ do destinatário não pode ser vazio");
    expect(mapearLinha(linhaBruta({ 8: "529.982.247-24" }), 2).erros).toContain("CPF/CNPJ do destinatário inválido");
  });

  it("reports an invalid email but accepts an empty one", () => {
    expect(mapearLinha(linhaBruta({ 11: "nao-e-email" }), 2).erros).toContain("Email do destinatário inválido");
    expect(mapearLinha(linhaBruta({ 11: "" }), 2).erros).toEqual([]);
  });

  it("reports missing package dimensions and weight", () => {
    const linha = mapearLinha(linhaBruta({ 12: "", 13: "", 14: "", 15: "" }), 2);

    expect(linha.erros).toContain("O peso do objeto não pode ser vazio");
    expect(linha.erros).toContain("Altura do objeto não pode ser vazia");
    expect(linha.erros).toContain("Largura do objeto não pode ser vazia");
    expect(linha.erros).toContain("Profundidade do objeto não pode ser vazia");
  });

  it("accepts a zero dimension, which is not the same as an empty one", () => {
    expect(mapearLinha(linhaBruta({ 16: 0 }), 2).erros).toEqual([]);
  });

  it("checks the NFe access key only when one was typed", () => {
    expect(mapearLinha(linhaBruta({ 20: "" }), 2).erros).toEqual([]);
    expect(mapearLinha(linhaBruta({ 20: "1234" }), 2).erros).toContain(
      "Chave de acesso da nota fiscal precisa ter 44 caracteres",
    );
    expect(mapearLinha(linhaBruta({ 20: "A".repeat(44) }), 2).erros).toContain(
      "Chave de acesso da nota fiscal não pode conter letras",
    );
    expect(mapearLinha(linhaBruta({ 20: "1".repeat(44) }), 2).erros).toEqual([]);
  });
});
