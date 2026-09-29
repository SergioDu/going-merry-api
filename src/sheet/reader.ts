// Reads the uploaded spreadsheet into raw rows. The template the clients
// download is a legacy .xls (BIFF8) but people re-save it as .xlsx constantly, so
// both go through SheetJS, which handles either from the same buffer.
//
// Nothing is interpreted here beyond "which rows carry data": the header row and
// the blank rows the editor leaves behind are dropped, and every remaining row
// keeps its line number in the sheet so an error can point the user at it.

import * as XLSX from "xlsx";

import { COLUMNS } from "./row";

// The first cell of the template's header row. A sheet that still has its header
// would otherwise be imported as a shipment addressed to "DESTINATARIO_NOME".
const HEADER = "DESTINATARIO_NOME";

export interface RawRow {
  // 1-based line number in the sheet, as the user sees it in Excel.
  line: number;
  cells: unknown[];
}

function isBlank(cells: unknown[]): boolean {
  return cells.every((cell) => cell === null || cell === undefined || String(cell).trim() === "");
}

// SheetJS happily reads a plain text file as a one-column CSV, which would turn a
// wrong upload into a sheet full of invalid rows instead of a clear message. Check
// the file signature up front: .xlsx is a zip, legacy .xls is an OLE2 compound
// file. Anything else is not the spreadsheet the user meant to send.
const XLSX_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK..
const XLS_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function isSpreadsheet(file: Buffer): boolean {
  return file.subarray(0, 4).equals(XLSX_SIGNATURE) || file.subarray(0, 8).equals(XLS_SIGNATURE);
}

export function readSheet(file: Buffer): RawRow[] {
  let sheet: XLSX.WorkSheet | undefined;

  if (!isSpreadsheet(file)) {
    throw new Error("Não foi possível ler o arquivo. Envie uma planilha .xls ou .xlsx");
  }

  try {
    const workbook = XLSX.read(file, { type: "buffer" });
    sheet = workbook.Sheets[workbook.SheetNames[0]];
  } catch {
    throw new Error("Não foi possível ler o arquivo. Envie uma planilha .xls ou .xlsx");
  }

  if (!sheet) {
    throw new Error("Não foi possível ler o arquivo. Envie uma planilha .xls ou .xlsx");
  }

  // header: 1 gives one array per row, addressed by column index like the log
  // reads it. blankrows keeps the empty ones for now so the line numbers stay
  // true to the sheet; they are dropped below.
  const all = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: "",
    blankrows: true,
  });

  const rows: RawRow[] = [];

  all.forEach((cells, index) => {
    if (isBlank(cells)) return;
    if (String(cells[COLUMNS.NAME] ?? "").trim().toUpperCase() === HEADER) return;

    rows.push({ line: index + 1, cells });
  });

  if (rows.length === 0) {
    throw new Error("Nenhuma linha encontrada na planilha");
  }

  return rows;
}
