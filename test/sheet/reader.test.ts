import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { readSheet } from "../../src/sheet/reader";

const HEADER = [
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
function spreadsheet(rows: unknown[][], format: XLSX.BookType = "xlsx"): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Planilha1");

  return XLSX.write(workbook, { type: "buffer", bookType: format }) as Buffer;
}

describe("readSheet", () => {
  it("reads an .xlsx file into rows, keeping each row's line number in the sheet", () => {
    const file = spreadsheet([HEADER, ["MARIA", "RUA A", "10"], ["JOAO", "RUA B", "20"]]);

    const rows = readSheet(file);

    expect(rows).toHaveLength(2);
    expect(rows[0].line).toBe(2);
    expect(rows[0].cells[0]).toBe("MARIA");
    expect(rows[1].line).toBe(3);
    expect(rows[1].cells[0]).toBe("JOAO");
  });

  it("reads a legacy .xls file the same way, since that is what the template is", () => {
    const file = spreadsheet([HEADER, ["MARIA", "RUA A", "10"]], "biff8");

    const rows = readSheet(file);

    expect(rows).toHaveLength(1);
    expect(rows[0].cells[0]).toBe("MARIA");
  });

  it("drops the header row wherever it sits", () => {
    const file = spreadsheet([HEADER, ["MARIA", "RUA A", "10"]]);

    expect(readSheet(file).every((row) => row.cells[0] !== "DESTINATARIO_NOME")).toBe(true);
  });

  it("skips blank rows left behind by the editor instead of reporting them as errors", () => {
    const file = spreadsheet([HEADER, ["MARIA", "RUA A", "10"], ["", "", ""], [], ["JOAO", "RUA B", "20"]]);

    const rows = readSheet(file);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.cells[0])).toEqual(["MARIA", "JOAO"]);
  });

  it("keeps numeric cells as numbers so the weight is not re-parsed from a formatted string", () => {
    const file = spreadsheet([HEADER, ["MARIA", "RUA A", 10]]);

    expect(readSheet(file)[0].cells[2]).toBe(10);
  });

  it("reads a file with no header row at all", () => {
    const file = spreadsheet([["MARIA", "RUA A", "10"]]);

    expect(readSheet(file)).toHaveLength(1);
  });

  it("rejects a file that is not a spreadsheet with a message the log can show", () => {
    expect(() => readSheet(Buffer.from("isto nao e uma planilha"))).toThrow(/não foi possível ler/i);
  });

  it("rejects an empty spreadsheet", () => {
    expect(() => readSheet(spreadsheet([HEADER]))).toThrow(/nenhuma linha/i);
  });
});
