import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { lerPlanilha } from "../../src/planilha/leitor";

const CABECALHO = [
  "DESTINATARIO_NOME",
  "DESTINATARIO_LOGRADOURO",
  "DESTINATARIO_NUMERO",
  "DESTINATARIO_COMPL",
  "DESTINATARIO_BAIRRO",
  "DESTINATARIO_CIDADE",
  "DESTINATARIO_UF",
  "DESTINATARIO_CEP",
];

// Builds a spreadsheet buffer in the format the log accepts. The templates the
// clients download are .xls (BIFF8), but people re-save them as .xlsx all the
// time, so both have to read the same.
function planilha(linhas: unknown[][], formato: XLSX.BookType = "xlsx"): Buffer {
  const livro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet(linhas), "Planilha1");

  return XLSX.write(livro, { type: "buffer", bookType: formato }) as Buffer;
}

describe("lerPlanilha", () => {
  it("reads an .xlsx file into rows, keeping each row's line number in the sheet", () => {
    const arquivo = planilha([CABECALHO, ["MARIA", "RUA A", "10"], ["JOAO", "RUA B", "20"]]);

    const linhas = lerPlanilha(arquivo);

    expect(linhas).toHaveLength(2);
    expect(linhas[0].linha).toBe(2);
    expect(linhas[0].celulas[0]).toBe("MARIA");
    expect(linhas[1].linha).toBe(3);
    expect(linhas[1].celulas[0]).toBe("JOAO");
  });

  it("reads a legacy .xls file the same way, since that is what the template is", () => {
    const arquivo = planilha([CABECALHO, ["MARIA", "RUA A", "10"]], "biff8");

    const linhas = lerPlanilha(arquivo);

    expect(linhas).toHaveLength(1);
    expect(linhas[0].celulas[0]).toBe("MARIA");
  });

  it("drops the header row wherever it sits", () => {
    const arquivo = planilha([CABECALHO, ["MARIA", "RUA A", "10"]]);

    expect(lerPlanilha(arquivo).every((linha) => linha.celulas[0] !== "DESTINATARIO_NOME")).toBe(true);
  });

  it("skips blank rows left behind by the editor instead of reporting them as errors", () => {
    const arquivo = planilha([CABECALHO, ["MARIA", "RUA A", "10"], ["", "", ""], [], ["JOAO", "RUA B", "20"]]);

    const linhas = lerPlanilha(arquivo);

    expect(linhas).toHaveLength(2);
    expect(linhas.map((linha) => linha.celulas[0])).toEqual(["MARIA", "JOAO"]);
  });

  it("keeps numeric cells as numbers so the weight is not re-parsed from a formatted string", () => {
    const arquivo = planilha([CABECALHO, ["MARIA", "RUA A", 10]]);

    expect(lerPlanilha(arquivo)[0].celulas[2]).toBe(10);
  });

  it("reads a file with no header row at all", () => {
    const arquivo = planilha([["MARIA", "RUA A", "10"]]);

    expect(lerPlanilha(arquivo)).toHaveLength(1);
  });

  it("rejects a file that is not a spreadsheet with a message the log can show", () => {
    expect(() => lerPlanilha(Buffer.from("isto nao e uma planilha"))).toThrow(/não foi possível ler/i);
  });

  it("rejects an empty spreadsheet", () => {
    expect(() => lerPlanilha(planilha([CABECALHO]))).toThrow(/nenhuma linha/i);
  });
});
