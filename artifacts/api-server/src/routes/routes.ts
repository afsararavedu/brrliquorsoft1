import type { Express } from "express";
import type { Server } from "http";
import { storage } from "../storage";
import { pool } from "../db";
import { api } from "../shared/routes";
import type { DailySale } from "@workspace/db";
import { z } from "zod";
import multer from "multer";
import * as XLSX from "xlsx";
import fs from "fs";
import path from "path";
import { createRequire } from "module";

// createRequire lets us reliably load CJS modules from this ESM bundle.
// Initialised once at module level so import.meta.url is resolved correctly
// at startup (not lazily inside an async callback where esbuild may inline it
// differently), and so there is no per-request overhead.
const _pdfRequire = createRequire(import.meta.url);

const upload = multer({ storage: multer.memoryStorage() });

const EMPTY_ORDER = {
  brandNumber: "",
  brandName: "",
  productType: "",
  packType: "",
  packSize: "",
  qtyCasesDelivered: 0,
  qtyBottlesDelivered: 0,
  ratePerCase: "0",
  unitRatePerBottle: "0",
  totalAmount: "0",
  breakageBottleQty: 0,
  remarks: "",
  invoiceDate: "",
  icdcNumber: "",
};

const COLUMN_MAP: Record<string, keyof typeof EMPTY_ORDER> = {
  "brand number": "brandNumber",
  brandnumber: "brandNumber",
  brand_number: "brandNumber",
  "brand no": "brandNumber",
  "brand no.": "brandNumber",
  "brand name": "brandName",
  brandname: "brandName",
  brand_name: "brandName",
  "product type": "productType",
  producttype: "productType",
  product_type: "productType",
  type: "productType",
  "pack type": "packType",
  packtype: "packType",
  pack_type: "packType",
  "pack size": "packSize",
  packsize: "packSize",
  pack_size: "packSize",
  "pack qty / size (ml)": "packSize",
  "pack qty": "packSize",
  "qty cases delivered": "qtyCasesDelivered",
  "qty cases": "qtyCasesDelivered",
  "cases delivered": "qtyCasesDelivered",
  cases: "qtyCasesDelivered",
  qty_cases_delivered: "qtyCasesDelivered",
  "qty bottles delivered": "qtyBottlesDelivered",
  "qty bottles": "qtyBottlesDelivered",
  "bottles delivered": "qtyBottlesDelivered",
  bottles: "qtyBottlesDelivered",
  qty_bottles_delivered: "qtyBottlesDelivered",
  "rate per case": "ratePerCase",
  "rate/case": "ratePerCase",
  rate_per_case: "ratePerCase",
  "unit rate per bottle": "unitRatePerBottle",
  "unit rate": "unitRatePerBottle",
  "rate/bottle": "unitRatePerBottle",
  unit_rate_per_bottle: "unitRatePerBottle",
  "total amount": "totalAmount",
  totalamount: "totalAmount",
  total_amount: "totalAmount",
  amount: "totalAmount",
  total: "totalAmount",
  "breakage bottle qty": "breakageBottleQty",
  breakage: "breakageBottleQty",
  breakage_bottle_qty: "breakageBottleQty",
  "breakage btl qty": "breakageBottleQty",
  remarks: "remarks",
  remark: "remarks",
  "invoice date": "invoiceDate",
  invoice_date: "invoiceDate",
  invoicedate: "invoiceDate",
  "icdc number": "icdcNumber",
  icdc_number: "icdcNumber",
  icdcnumber: "icdcNumber",
  "icdc no": "icdcNumber",
};

function mapHeaderToField(header: string): keyof typeof EMPTY_ORDER | null {
  // Strip colons and normalize so "Invoice Date:" matches "invoice date"
  const normalized = header.trim().toLowerCase().replace(/:/g, "").trim();
  return COLUMN_MAP[normalized] || null;
}

/** Pad brand numbers to 4 digits with leading zeros (e.g. "19" → "0019", "110" → "0110") */
function padBrandNumber(raw: string): string {
  const s = String(raw).trim();
  // Only pad if it's a pure numeric string of fewer than 4 digits
  if (/^\d{1,3}$/.test(s)) return s.padStart(4, "0");
  return s;
}

function rowToOrder(
  row: Record<string, any>,
  headerMap: Record<string, keyof typeof EMPTY_ORDER>,
): typeof EMPTY_ORDER {
  const order = { ...EMPTY_ORDER };
  for (const [col, field] of Object.entries(headerMap)) {
    const val = row[col];
    if (val === undefined || val === null || val === "") continue;
    if (
      field === "qtyCasesDelivered" ||
      field === "qtyBottlesDelivered" ||
      field === "breakageBottleQty"
    ) {
      (order as any)[field] = parseInt(String(val)) || 0;
    } else if (
      field === "ratePerCase" ||
      field === "unitRatePerBottle" ||
      field === "totalAmount"
    ) {
      const numVal = parseFloat(String(val).replace(/,/g, ""));
      (order as any)[field] = isNaN(numVal) ? "0" : numVal.toFixed(2);
    } else if (field === "invoiceDate") {
      // Excel stores dates as serial numbers — convert to readable string
      if (typeof val === "number" && val > 1000) {
        (order as any)[field] = excelSerialToDateStr(val);
      } else {
        (order as any)[field] = String(val).trim();
      }
    } else if (field === "brandNumber") {
      (order as any)[field] = padBrandNumber(String(val));
    } else {
      (order as any)[field] = String(val);
    }
  }
  return order;
}

function excelSerialToDateStr(serial: number): string {
  // Excel stores dates as days since 1899-12-30
  const date = new Date((serial - 25569) * 86400 * 1000);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const month = months[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

function parseSpreadsheet(buffer: Buffer, filename: string) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const jsonRows: Record<string, any>[] = XLSX.utils.sheet_to_json(sheet, {
    defval: "",
    raw: true,
  });

  if (jsonRows.length === 0) {
    throw new Error("The file appears to be empty or has no data rows.");
  }

  const headers = Object.keys(jsonRows[0]);
  const headerMap: Record<string, keyof typeof EMPTY_ORDER> = {};
  for (const h of headers) {
    const field = mapHeaderToField(h);
    if (field) {
      headerMap[h] = field;
    }
  }

  if (Object.keys(headerMap).length === 0) {
    const orders: (typeof EMPTY_ORDER)[] = [];
    for (const row of jsonRows) {
      const vals = Object.values(row)
        .map((v) => String(v).trim())
        .filter(Boolean);
      if (vals.length >= 2) {
        orders.push({
          ...EMPTY_ORDER,
          brandNumber: padBrandNumber(vals[0] || ""),
          brandName: vals[1] || "",
          productType: vals[2] || "",
          packType: vals[3] || "",
          packSize: vals[4] || "",
          qtyCasesDelivered: parseInt(vals[5]) || 0,
          qtyBottlesDelivered: parseInt(vals[6]) || 0,
          ratePerCase: (parseFloat(vals[7]) || 0).toFixed(2),
          unitRatePerBottle: (parseFloat(vals[8]) || 0).toFixed(2),
          totalAmount: (parseFloat(vals[9]) || 0).toFixed(2),
          breakageBottleQty: parseInt(vals[10]) || 0,
          remarks: vals[11] || "",
        });
      }
    }
    return orders;
  }

  return jsonRows.map((row) => rowToOrder(row, headerMap));
}

async function parsePdfInvoice(
  buffer: Buffer,
): Promise<{ orders: (typeof EMPTY_ORDER)[]; shopDetail: Record<string, string> | null }> {
  // Use pdf-parse with a custom pagerender callback so we get the full pdfjs
  // PageProxy (and can call getTextContent) while letting pdf-parse handle
  // all Node.js polyfills (DOMMatrix, canvas, etc.) internally.
  // pdfjs-dist is NOT loaded directly here — that avoids the "DOMMatrix is
  // not defined" / "use legacy build" errors that arise when loading pdfjs
  // outside its bundled shim environment.
  // pdf-parse v1.1.1's index.js runs a test file on import (ENOENT in prod).
  // Use lib/pdf-parse.js directly to bypass the test runner.
  // _pdfRequire is the module-level createRequire initialised at startup —
  // avoids a dynamic import() inside an async callback which esbuild can
  // mis-handle, causing "pdfParse is not a function" on EC2.
  const pdfParse = _pdfRequire("pdf-parse/lib/pdf-parse.js") as (
    buf: Buffer,
    opts?: Record<string, unknown>,
  ) => Promise<{ text: string; numpages: number }>;

  // Extract text in natural content-stream order (left→right within each
  // Y band, top→bottom page by page). The pagerender callback receives the
  // live pdfjs PageProxy from pdf-parse's own bundled pdfjs copy.
  let allText = "";
  async function renderPage(pageData: any): Promise<string> {
    // Use options compatible with pdf-parse v1.1.1's bundled pdfjs (v1.x/v2.x).
    // `includeMarkedContent` was added in pdfjs v2.4+ and is not recognised here.
    const content = await pageData.getTextContent({
      normalizeWhitespace: false,
      disableCombineTextItems: false,
    });
    let prevY: number | null = null;
    let line = "";
    for (const item of content.items as any[]) {
      if (typeof (item as any).str !== "string") continue;
      const y = Math.round((item as any).transform[5]);
      if (prevY !== null && Math.abs(y - prevY) > 1) {
        if (line.trim()) allText += line.trim() + "\n";
        line = "";
      }
      line += (item as any).str;
      prevY = y;
    }
    if (line.trim()) allText += line.trim() + "\n";
    // Return empty string — we collect text via closure, not via pdf-parse's accumulator.
    return "";
  }

  await pdfParse(buffer, { pagerender: renderPage });
  // eslint-disable-next-line no-console
  console.log(`[PDF] extracted ${allText.split("\n").length} lines, ${allText.length} chars`);

  const lines = allText
    .split("\n")
    .map((l: string) => l.replace(/\t/g, " ").trim())
    .filter(Boolean);

  let invoiceDate = "";
  let icdcNumber = "";
  let shopName = "";
  let shopAddress = "";
  let retailShopExciseTax = "";
  let licenseNo = "";
  let panNumber = "";
  let namePhone = "";
  let gazetteCodeLicenseeIssueDate = "";

  for (const line of lines) {
    const dateMatch = line.match(/Invoice\s*Date\s*:\s*(.+?)(?:\s{2,}|$)/i);
    if (dateMatch && !invoiceDate) {
      invoiceDate = normalizeInvoiceDate(dateMatch[1].trim()) ?? dateMatch[1].trim();
    }
    const icdcMatch = line.match(/ICDC\s*Number\s*[:\s]\s*(ICDC\S+)/i);
    if (icdcMatch && !icdcNumber) {
      icdcNumber = icdcMatch[1].trim();
    }
    if (!icdcNumber) {
      const standaloneIcdc = line.match(/^(ICDC\d{10,})$/);
      if (standaloneIcdc) {
        icdcNumber = standaloneIcdc[1].trim();
      }
    }

    // ----- Tabular header row: "Retailer Name: M/s Foo Code: 2501550" -----
    // Extract Name (shop name) — stop at "Code"/"Address"/"License"/double-space/EOL
    if (!shopName) {
      const nameMatch = line.match(
        /(?:^|\b)Name\s*[:.]\s*(.+?)(?=\s+(?:Code|Address|License|Retail\s*Shop|PAN|Phone|Mobile|Contact|Gazette|ICDC)\s*[:.]|\s{2,}|$)/i,
      );
      // Avoid matching "Name & Phone:" or "Name, Phone:" header fields
      if (nameMatch && !line.match(/Name\s*[&,/]\s*(?:Phone|Mobile|Contact)/i)) {
        const candidate = nameMatch[1].trim();
        if (candidate && candidate.length >= 2) shopName = candidate;
      }
    }

    // Address — stop at "Retail Shop Excise Tax"/"Code"/etc
    if (!shopAddress) {
      const addrMatch = line.match(
        /(?:^|\b)Address\s*[:.]\s*(.+?)(?=\s+(?:Retail\s*Shop|Code|License|PAN|Phone|Mobile|Gazette|ICDC|Name)\s*[:.]|\s{2,}|$)/i,
      );
      if (addrMatch) {
        const candidate = addrMatch[1].trim();
        if (candidate && candidate.length >= 2) shopAddress = candidate;
      }
    }

    const licMatch = line.match(/License\s*No\s*[:.]\s*(.+?)(?=\s+(?:PAN|Code|Retail|Name|Phone|Gazette|ICDC)\s*[:.]|\s{2,}|$)/i);
    if (licMatch && !licenseNo) {
      licenseNo = licMatch[1].trim();
    }

    const panMatch = line.match(/PAN\s*(?:Number|No)?\s*[:.]\s*(.+?)(?=\s+(?:License|Code|Retail|Name|Phone|Gazette|ICDC)\s*[:.]|\s{2,}|$)/i);
    if (panMatch && !panNumber) {
      panNumber = panMatch[1].trim();
    }

    const exciseMatch = line.match(/Retail\s*Shop\s*Excise\s*Tax\s*[:.]\s*(.+?)(?=\s+(?:License|Code|PAN|Name|Phone|Gazette|ICDC|Address)\s*[:.]|\s{2,}|$)/i);
    if (exciseMatch && !retailShopExciseTax) {
      retailShopExciseTax = exciseMatch[1].trim();
    }

    // Legacy fallback: "Address ... Retail Shop Excise Tax: ..." with no "Address:" label
    if (!retailShopExciseTax && line.match(/Retail\s*Shop\s*Excise\s*Tax/i)) {
      const addressLine = line.trim();
      const exciseParts = addressLine.split(/Retail\s*Shop\s*Excise\s*Tax\s*/i);
      if (exciseParts.length > 1) {
        retailShopExciseTax = exciseParts[1].replace(/^[:.]\s*/, "").trim();
        if (!shopAddress && exciseParts[0]) {
          // strip leading row labels like "Retailer" if present
          shopAddress = exciseParts[0].replace(/^(Retailer|Licensee)\s+/i, "").trim();
        }
      }
    }

    const phoneMatch = line.match(/(?:Name|Phone|Mobile|Contact)\s*[&\/,]\s*(?:Phone|Name|Mobile|Contact)\s*[:.]\s*(.+)/i);
    if (phoneMatch && !namePhone) {
      namePhone = phoneMatch[1].trim();
    }

    const gazetteMatch = line.match(/Gazette\s*Code\s*[&,]\s*Licensee\s*Issue\s*Date\s*[:.]\s*(.+)/i);
    if (gazetteMatch && !gazetteCodeLicenseeIssueDate) {
      gazetteCodeLicenseeIssueDate = gazetteMatch[1].trim();
    }
    if (!gazetteCodeLicenseeIssueDate) {
      const altGazette = line.match(/Gazette\s*Code.*?[:.]\s*(.+)/i);
      if (altGazette) {
        gazetteCodeLicenseeIssueDate = altGazette[1].trim();
      }
    }
  }

  // Last-resort fallback if explicit "Name:" wasn't found anywhere in the PDF
  if (lines.length > 0 && !shopName) {
    for (let idx = 0; idx < Math.min(8, lines.length); idx++) {
      const l = lines[idx];
      if (l.match(/^(Duplicate|Original|Tax\s*Invoice|Invoice\s*No|Sl\.?\s*No|ICDC|Invoice\s*Date|Retailer|Licensee)/i)) continue;
      if (l.match(/License\s*No|PAN|Gazette|Retail\s*Shop|Code\s*[:.]/i)) continue;
      if (!shopName) {
        shopName = l;
        continue;
      }
      if (!shopAddress && !l.match(/License\s*No|PAN|Gazette|Retail\s*Shop|Invoice|Code\s*[:.]/i)) {
        shopAddress = l;
        break;
      }
    }
  }

  const shopDetail: Record<string, string> = {
    name: shopName,
    address: shopAddress,
    retailShopExciseTax,
    licenseNo,
    panNumber,
    namePhone,
    invoiceDate,
    gazetteCodeLicenseeIssueDate,
    icdcNumber,
  };

  const hasShopData = Object.values(shopDetail).some(v => v && v.length > 0);
  

  // ── ICDC PDF structure (Y-band extraction collapses columns without spaces) ──
  //
  // Each product row spans several Y-band lines in one of two layouts:
  //
  //  Case A — brand name on a different Y level than the sl_no (most rows):
  //    "{sl_no}{brand_no}"                              e.g. "15016"
  //    "{brand_name_part1}"                             e.g. "KING FISHER PREMIUM LAGER"
  //    "{brand_name_part2}"   (optional)                e.g. "BEER"
  //    "{product_type}{pack_type}{size}{qty_cases}{qty_bottles}"   e.g. "BeerG12 / 650 ml680"
  //    "{rate_per_case} /"                              e.g. "1,501.00 /"
  //    "{btl_rate}"                                     e.g. "125.08"
  //    "{total}"                                        e.g. "1,02,068.00"
  //
  //  Case B — everything on one Y (shorter brand names):
  //    "{sl_no}{brand_no}{brand_name}{product_type}{pack_type}{size}{qty_cases}{qty_bottles}"
  //    "{rate_per_case} /"
  //    "{btl_rate}"
  //    "{total}"
  //
  // Brand numbers in ICDC are always 4 digits; sl_no is 1–4 digits.

  const cleanNum = (s: string | undefined) => (s || "0").replace(/,/g, "").trim();
  const sizeRe = /\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\s*(?:ml|ltrs?|ltr?|litre?s?)/gi;

  // Split concatenated qty string (e.g. "680" → 68 cases, 0 bottles).
  // qty_bottles is 0–11; tries 2-digit split if last-2 digits are 10–11, else 1-digit split.
  const splitQty = (digits: string): [number, number] => {
    if (!digits || digits.length <= 1) return [parseInt(digits) || 0, 0];
    const last2 = parseInt(digits.slice(-2));
    if (digits.length >= 3 && last2 >= 10 && last2 <= 11)
      return [parseInt(digits.slice(0, -2)) || 0, last2];
    return [parseInt(digits.slice(0, -1)) || 0, parseInt(digits.slice(-1)) || 0];
  };

  // Parse a "data line" that has product/pack/size/qty all concatenated, e.g. "BeerG12 / 650 ml680".
  const parseDataLine = (rl: string): { productType: string; packType: string; packSize: string; qtyCases: number; qtyBottles: number } | null => {
    sizeRe.lastIndex = 0;
    const sm = sizeRe.exec(rl);
    if (!sm) return null;
    const sizeStr = sm[0];
    const before = rl.substring(0, sm.index).trim();
    const after  = rl.substring(sm.index + sizeStr.length).trim();
    const pm = before.match(/^(Beer|IML|IMFL|Wine|RTD|Duty\s*Paid|Duty\s*Free)\s*([A-Z])$/i);
    let productType = "", packType = "";
    if (pm) { productType = pm[1].trim(); packType = pm[2].trim(); }
    else { const lc = before.match(/([A-Z])$/); if (lc) { packType = lc[1]; productType = before.slice(0, -1).trim(); } else productType = before.trim(); }
    const packSize = sizeStr.replace(/\s+/g, " ").replace(/\s*\/\s*/g, " / ").trim();
    const [qtyCases, qtyBottles] = splitQty(after.replace(/\D/g, ""));
    return { productType, packType, packSize, qtyCases, qtyBottles };
  };

  // Extract brand name + product/pack type from the text before the size in a Case B line.
  // e.g. "BUDWEISER KING OF BEERSBeerG" → { brandName: "BUDWEISER KING OF BEERS", productType: "Beer", packType: "G" }
  const parseBefore = (before: string): { brandName: string; productType: string; packType: string } => {
    const full = before.match(/^(.*?)(Beer|IML|IMFL|Wine|RTD|Duty\s*Paid|Duty\s*Free)\s*([A-Z])$/i);
    if (full) return { brandName: full[1].trim(), productType: full[2].trim(), packType: full[3].trim() };
    const alt = before.match(/^(.*?)([A-Z])$/);
    if (alt) return { brandName: alt[1].trim(), productType: "", packType: alt[2].trim() };
    return { brandName: before.trim(), productType: "", packType: "" };
  };

  // An sl_no line starts with 1–4 digits (sl_no) immediately followed by 4 digits (brand_no).
  const slNoLineRe = /^(\d{1,4})(\d{4})(.*)/;
  const stopRe = /^(Invoice\s*Qty|Breakage|Shortage|Reverted|Total\s*\(|Net\s*Invoice|Invoice\s*Value|Amount\s*in\s*Words|e-challan|Particulars|Authorized|Sub\s*Total|Grand\s*Total|TIN\s*NO|CST\s*NO|5\/|https?:\/\/)/i;

  const parsedOrders: (typeof EMPTY_ORDER)[] = [];
  const skippedLines: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (stopRe.test(line)) { i++; continue; }

    const slMatch = line.match(slNoLineRe);
    if (!slMatch) { i++; continue; }

    const brandNumber = slMatch[2];
    const inlineSuffix = slMatch[3]; // text after brand_no on the same Y (Case B) or empty (Case A)
    i++;

    // Collect all lines belonging to this row until the next sl_no or stop line.
    const rowLines: string[] = [];
    while (i < lines.length) {
      const next = lines[i];
      if (stopRe.test(next) || next.match(slNoLineRe)) break;
      rowLines.push(next);
      i++;
    }

    let brandName = "", productType = "", packType = "", packSize = "";
    let qtyCases = 0, qtyBottles = 0;
    let ratePerCase = "", unitRate = "", totalAmount = "";
    const brandParts: string[] = [];
    let rateFound = false, unitRateFound = false;

    // Case B: the inline suffix (after brand_no) already contains the size.
    sizeRe.lastIndex = 0;
    if (inlineSuffix && sizeRe.test(inlineSuffix)) {
      sizeRe.lastIndex = 0;
      const sm = sizeRe.exec(inlineSuffix);
      if (sm) {
        const before = inlineSuffix.substring(0, sm.index);
        const after  = inlineSuffix.substring(sm.index + sm[0].length);
        const p = parseBefore(before);
        brandName = p.brandName; productType = p.productType; packType = p.packType;
        packSize = sm[0].replace(/\s+/g, " ").replace(/\s*\/\s*/g, " / ").trim();
        [qtyCases, qtyBottles] = splitQty(after.replace(/\D/g, ""));
      }
    }

    // Parse remaining row lines for: brand name (Case A), data line (Case A), rate, btl rate, total.
    for (const rl of rowLines) {
      // Rate/case: a number followed by " /"  e.g. "1,501.00 /"
      if (!rateFound && /^[\d,]+\.?\d*\s*\/$/.test(rl)) {
        ratePerCase = cleanNum(rl.replace(/\s*\/$/, "").trim());
        rateFound = true;
        continue;
      }
      // Btl rate: first pure number after the rate line
      if (rateFound && !unitRateFound && /^[\d,]+\.?\d*$/.test(rl)) {
        unitRate = cleanNum(rl);
        unitRateFound = true;
        continue;
      }
      // Total: next pure number after btl rate
      if (unitRateFound && !totalAmount && /^[\d,]+\.?\d*$/.test(rl)) {
        totalAmount = cleanNum(rl);
        continue;
      }
      // Data line (Case A): contains a size pattern  e.g. "BeerG12 / 650 ml680"
      if (!packSize) {
        const d = parseDataLine(rl);
        if (d) {
          productType = d.productType; packType = d.packType;
          packSize = d.packSize; qtyCases = d.qtyCases; qtyBottles = d.qtyBottles;
          continue;
        }
      }
      // Brand name text (Case A): non-empty lines before the data line and before rate
      if (!packSize && rl.trim() && !rateFound) brandParts.push(rl.trim());
    }

    // In Case A, brand name is built from the collected text lines above the data line.
    if (!brandName && brandParts.length > 0) brandName = brandParts.join(" ").trim();

    if (!packSize) {
      skippedLines.push(`brand=${brandNumber} inline="${inlineSuffix.substring(0, 60)}"`);
      continue;
    }

    parsedOrders.push({
      ...EMPTY_ORDER,
      brandNumber,
      brandName: brandName.replace(/\s+/g, " ").trim(),
      productType,
      packType,
      packSize,
      qtyCasesDelivered: qtyCases,
      qtyBottlesDelivered: qtyBottles,
      ratePerCase,
      unitRatePerBottle: unitRate,
      totalAmount,
      invoiceDate,
      icdcNumber,
    });
  }

  if (parsedOrders.length === 0) {
    throw new Error(
      "Could not extract any order data from the PDF. Please ensure it follows the invoice format.",
    );
  }

  console.log(`[PDF parser] Parsed ${parsedOrders.length} rows.${skippedLines.length > 0 ? ` Skipped ${skippedLines.length} rows:` : " No rows skipped."}`);
  if (skippedLines.length > 0) {
    skippedLines.forEach(s => console.log("  SKIPPED:", s));
  }

  return { orders: parsedOrders, shopDetail: hasShopData ? shopDetail : null, skippedLines };
}

async function parseUploadedFile(buffer: Buffer, filename: string): Promise<{ orders: (typeof EMPTY_ORDER)[]; shopDetail: Record<string, string> | null; skippedLines?: string[] }> {
  const ext = filename.toLowerCase().split(".").pop() || "";

  if (ext === "csv" || ext === "xls" || ext === "xlsx") {
    return { orders: parseSpreadsheet(buffer, filename), shopDetail: null, skippedLines: [] };
  } else if (ext === "pdf") {
    return parsePdfInvoice(buffer);
  } else {
    throw new Error(
      `Unsupported file type: .${ext}. Please upload .csv, .xls, .xlsx, or .pdf files.`,
    );
  }
}

import { setupAuth, requireAuth, requireAdmin } from "../auth";
import bcrypt from "bcryptjs";

import { logger } from "../lib/logger";

/** Convert various invoice date formats to YYYY-MM-DD for comparison */
function normalizeInvoiceDate(invDate: string): string | null {
  if (!invDate) return null;
  // Already ISO: "2025-12-30"
  if (/^\d{4}-\d{2}-\d{2}$/.test(invDate)) return invDate;
  // "30-Dec-2025" or "30-Jan-2026"
  const MONTHS: Record<string, string> = {
    jan:"01", feb:"02", mar:"03", apr:"04", may:"05", jun:"06",
    jul:"07", aug:"08", sep:"09", oct:"10", nov:"11", dec:"12",
  };
  const m1 = invDate.match(/^(\d{1,2})-([A-Za-z]+)-(\d{4})$/);
  if (m1) {
    const monthNum = MONTHS[m1[2].toLowerCase()];
    if (monthNum) return `${m1[3]}-${monthNum}-${m1[1].padStart(2, "0")}`;
  }
  // "30/12/2025" or "30-12-2025"
  const m2 = invDate.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m2) return `${m2[3]}-${m2[2].padStart(2,"0")}-${m2[1].padStart(2,"0")}`;
  return null;
}

/** Extract size string from packSize like "48 / 180 ml" → "180 ml" */
function extractSizeFromPackSize(packSize: string): string {
  const parts = packSize.split("/");
  return parts.length >= 2 ? parts[1].trim() : packSize.trim();
}

/** Extract qty-per-case from packSize like "48 / 180 ml" → 48 (number before '/') */
function extractQtyPerCaseFromPackSize(packSize: string): number {
  const parts = packSize.split("/");
  if (parts.length >= 2) {
    const num = parseInt(parts[0].trim(), 10);
    return isNaN(num) ? 0 : num;
  }
  return 0;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  setupAuth(app);

  // From this point on, every /api route requires an authenticated session.
  // Public auth endpoints (login, register, logout, user, forgot/reset
  // password) are registered above inside setupAuth(), and the unauthenticated
  // /api/healthz check is mounted in app.ts before this middleware runs.
  app.use("/api", requireAuth);

  // Sales
  app.get(api.sales.list.path, async (req, res) => {
    const date = req.query.date as string | undefined;
    if (date) {
      const sales = await storage.getDailySalesByDate(date);

      // Opening balance priority chain for date D:
      //   1. daily_stock[D-1].totalStockBottles  (saved snapshot — most accurate)
      //      If D-1 has no snapshot, use the most recent daily_stock before D
      //      (handles gaps where a day was skipped without saving)
      //   2. daily_sales[D-1].totalClosingStock   (saved records but no snapshot)
      //   3. stock_details.totalStockBottles       (current stock — covers "new stock
      //      received but no sales entered yet" scenario)
      const prevDate = new Date(date);
      prevDate.setDate(prevDate.getDate() - 1);
      const prevDateStr = prevDate.toISOString().split("T")[0];

      // Fetch all required data in parallel (5 queries → 1 parallel round-trip)
      const [rawPrevDayStock, prevDaySales, allStock, allOrders, salesMrpList] = await Promise.all([
        storage.getDailyStockByDate(prevDateStr),
        storage.getDailySalesByDate(prevDateStr),
        storage.getStockDetails(),
        storage.getOrders(),
        storage.getSalesMrpDetails(),
      ]);

      // If no snapshot for D-1, fall back to the most recent available snapshot before D
      const prevDayStock =
        rawPrevDayStock.length > 0
          ? rawPrevDayStock
          : await storage.getMostRecentDailyStockBefore(date);

      // Build normalised helpers
      const normSize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "");
      const normStr  = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "");

      // 4-field key: Brand No | Brand Name | Size | Qty/Cs
      // Used for opening balance matching across daily_stock, daily_sales, stock_details
      const normKey4 = (brandNo: string, brandName: string, size: string, qtyPerCase: number) =>
        `${brandNo}|${normStr(brandName)}|${normSize(size)}|${qtyPerCase}`;

      // 2-field key: Brand No | Size (used for order aggregation only — orders lack brandName/qty reliably)
      const normKey2 = (brandNo: string, size: string) =>
        `${brandNo}|${normSize(size)}`;

      // Step 1: Build orderNewStk first (needed for opening balance calculation below)
      // New Stock (Cs/Btls): aggregate from orders whose invoice_date matches selected date
      const matchingOrders = allOrders.filter((o) => {
        const norm = normalizeInvoiceDate(o.invoiceDate || "");
        return norm === date;
      });

      type OrderAgg = { cases: number; bottles: number };
      const orderNewStk = new Map<string, OrderAgg>();
      // Also track qty-per-case extracted from pack_size for each brand+size
      const orderQtyMap = new Map<string, number>();
      for (const o of matchingOrders) {
        const size = extractSizeFromPackSize(o.packSize);
        const key = normKey2(o.brandNumber, size);
        const existing = orderNewStk.get(key) || { cases: 0, bottles: 0 };
        existing.cases += o.qtyCasesDelivered ?? 0;
        existing.bottles += o.qtyBottlesDelivered ?? 0;
        orderNewStk.set(key, existing);
        // Extract qty/cs from pack_size (number before '/') — store once per brand+size
        if (!orderQtyMap.has(key)) {
          const qty = extractQtyPerCaseFromPackSize(o.packSize);
          if (qty > 0) orderQtyMap.set(key, qty);
        }
      }

      // Step 2: Build TWO opening balance maps keyed on all 4 fields
      // (Brand No + Brand Name + Size + Qty/Cs) to match exactly what the
      // Stock page shows for D-1 ("Tot Stk (Btls)").
      //
      // openingBalMapStrict: EXISTING saved records — only confirmed historical
      //   sources (daily_stock[D-1] → daily_sales[D-1]).  No stock_details fallback.
      //
      // openingBalMapFull: VIRTUAL rows — adds stock_details as final fallback so
      //   new dates always show something before the user saves any sales.

      const openingBalMapStrict = new Map<string, number>();
      // Level 2: previous day's daily_sales closing stock
      for (const s of prevDaySales) {
        const key = normKey4(s.brandNumber, s.brandName, s.size, s.quantityPerCase ?? 0);
        openingBalMapStrict.set(key, s.totalClosingStock ?? 0);
      }
      // Level 1 (highest): previous day's daily_stock snapshot — "Tot Stk (Btls)"
      for (const s of prevDayStock) {
        const key = normKey4(s.brandNumber, s.brandName, s.size, s.quantityPerCase ?? 0);
        openingBalMapStrict.set(key, s.totalStockBottles ?? 0);
      }

      // Full map: openingBalMapStrict + stock_details fallback (minus today's orders)
      const openingBalMapFull = new Map<string, number>(openingBalMapStrict);
      for (const s of allStock) {
        const key4 = normKey4(s.brandNumber, s.brandName ?? "", s.size, s.quantityPerCase ?? 0);
        if (!openingBalMapFull.has(key4)) {
          const qtyPerCase = s.quantityPerCase ?? 12;
          const orderKey = normKey2(s.brandNumber, s.size);
          const todayOrders = orderNewStk.get(orderKey);
          const todayOrderBottles = todayOrders
            ? todayOrders.cases * qtyPerCase + todayOrders.bottles
            : 0;
          const openingBalance = Math.max(0, (s.totalStockBottles ?? 0) - todayOrderBottles);
          openingBalMapFull.set(key4, openingBalance);
        }
      }

      // Build MRP override lookup (salesMrpList fetched in the parallel Promise.all above)
      const findMrpOverride = (brandNumber: string, size: string) => {
        return salesMrpList.find((m) => {
          if (m.brandNumber !== brandNumber) return false;
          const sNorm = normSize(m.size);
          const dNorm = normSize(size);
          return sNorm === dNorm || sNorm.includes(dNorm) || dNorm.includes(sNorm);
        });
      };

      // Fallback: look up MRP from stock_details when sale.mrp is missing/zero
      const findStockMrp = (brandNumber: string, size: string): string | null => {
        const match = allStock.find((s) => {
          if (s.brandNumber !== brandNumber) return false;
          const sNorm = normSize(s.size);
          const dNorm = normSize(size);
          return sNorm === dNorm || sNorm.includes(dNorm) || dNorm.includes(sNorm);
        });
        const v = parseFloat(match?.mrp as string);
        return (match && !isNaN(v) && v > 0) ? String(v) : null;
      };

      // If no daily_sales exist for this date yet, generate virtual rows.
      // CASE 2: Orders exist for this date → orders = new stock; prev day daily_sales = opening balance
      //   • Match orders vs prev day daily_sales by Brand No + Brand Name + Size
      //   • Unmatched prev day rows carry forward (opening balance, no new stock)
      // CASE 1: No orders for this date → use prev day daily_sales as carry-forward rows
      // FALLBACK: neither → use stock_details (legacy behaviour)
      if (sales.length === 0) {
        // 3-field key for prev-day matching: Brand No | Brand Name | Size
        const normKey3 = (brandNo: string, brandName: string, size: string) =>
          `${brandNo}|${normStr(brandName)}|${normSize(size)}`;

        // Build prev-day map by Brand No + Brand Name + Size
        const prevDayMap = new Map<string, typeof prevDaySales[0]>();
        for (const s of prevDaySales) {
          prevDayMap.set(normKey3(s.brandNumber, s.brandName, s.size), s);
        }

        // Helper to build a virtual row from base fields
        const makeVirtualRow = (
          idx: number,
          brandNumber: string,
          brandName: string,
          size: string,
          quantityPerCase: number,
          openingBalanceBottles: number,
          newStockCases: number,
          newStockBottles: number,
          mrpVal: string,
        ) => ({
          id: -(idx + 1),
          brandNumber,
          brandName,
          size,
          quantityPerCase,
          openingBalanceBottles,
          newStockCases,
          newStockBottles,
          closingBalanceCases: 0,
          closingBalanceBottles: 0,
          soldBottles: 0,
          mrp: mrpVal,
          saleValue: "0",
          totalSaleValue: "0",
          breakageBottles: 0,
          totalClosingStock: 0,
          finalClosingBalance: 0,
          saleDate: date,
          invoiceDate: null,
          isSubmitted: false,
          createdAt: null,
        });

        if (matchingOrders.length > 0) {
          // ── CASE 2: orders exist ──
          // Aggregate matching orders by Brand No + Size; keep packSize so we can extract qty/cs
          type OrderRowAgg = { brandNumber: string; brandName: string; size: string; packSize: string; cases: number; bottles: number };
          const orderRowMap = new Map<string, OrderRowAgg>();
          for (const o of matchingOrders) {
            const size = extractSizeFromPackSize(o.packSize);
            const key = normKey2(o.brandNumber, size);
            const existing = orderRowMap.get(key);
            if (existing) {
              existing.cases += o.qtyCasesDelivered ?? 0;
              existing.bottles += o.qtyBottlesDelivered ?? 0;
            } else {
              orderRowMap.set(key, { brandNumber: o.brandNumber, brandName: o.brandName, size, packSize: o.packSize, cases: o.qtyCasesDelivered ?? 0, bottles: o.qtyBottlesDelivered ?? 0 });
            }
          }

          const virtualRows: ReturnType<typeof makeVirtualRow>[] = [];
          const matchedPrevKeys = new Set<string>();

          for (const [, ord] of Array.from(orderRowMap.entries())) {
            // Try to find prev-day sale by Brand No + Brand Name + Size
            const key3 = normKey3(ord.brandNumber, ord.brandName, ord.size);
            const prevSale = prevDayMap.get(key3);
            if (prevSale) matchedPrevKeys.add(key3);

            const openingBalance = prevSale ? (prevSale.totalClosingStock ?? 0) : 0;
            const stockMatch = allStock.find((s) => normKey2(s.brandNumber, s.size) === normKey2(ord.brandNumber, ord.size));
            // Priority: order packSize → prev day daily_sales → stock_details → 12
            const qtyFromOrder = extractQtyPerCaseFromPackSize(ord.packSize);
            const qtyPerCase = qtyFromOrder > 0 ? qtyFromOrder : (prevSale?.quantityPerCase ?? stockMatch?.quantityPerCase ?? 12);
            const mrpOverride = findMrpOverride(ord.brandNumber, ord.size);
            const mrpVal = mrpOverride ? mrpOverride.salesMrp : (prevSale?.mrp ?? stockMatch?.mrp ?? "0");

            virtualRows.push(makeVirtualRow(virtualRows.length, ord.brandNumber, ord.brandName, ord.size, qtyPerCase, openingBalance, ord.cases, ord.bottles, mrpVal));
          }

          // Carry-forward: prev day rows that had no matching order
          for (const [key3, prevSale] of Array.from(prevDayMap.entries())) {
            if (!matchedPrevKeys.has(key3)) {
              const mrpOverride = findMrpOverride(prevSale.brandNumber, prevSale.size);
              const prevMrpNum = parseFloat(prevSale.mrp as string);
              const mrpVal = mrpOverride
                ? mrpOverride.salesMrp
                : (!isNaN(prevMrpNum) && prevMrpNum > 0)
                  ? (prevSale.mrp ?? "0")
                  : (findStockMrp(prevSale.brandNumber, prevSale.size) ?? prevSale.mrp ?? "0");
              virtualRows.push(makeVirtualRow(virtualRows.length, prevSale.brandNumber, prevSale.brandName, prevSale.size, prevSale.quantityPerCase ?? 12, prevSale.totalClosingStock ?? 0, 0, 0, mrpVal));
            }
          }

          return res.json(virtualRows);
        }

        // ── CASE 1: No orders → carry prev day daily_sales forward ──
        if (prevDaySales.length > 0) {
          const virtualRows = prevDaySales.map((sale, idx) => {
            const mrpOverride = findMrpOverride(sale.brandNumber, sale.size);
            const prevMrpNum = parseFloat(sale.mrp as string);
            const mrpVal = mrpOverride
              ? mrpOverride.salesMrp
              : (!isNaN(prevMrpNum) && prevMrpNum > 0)
                ? (sale.mrp ?? "0")
                : (findStockMrp(sale.brandNumber, sale.size) ?? sale.mrp ?? "0");
            return makeVirtualRow(idx, sale.brandNumber, sale.brandName, sale.size, sale.quantityPerCase ?? 12, sale.totalClosingStock ?? 0, 0, 0, mrpVal);
          });
          return res.json(virtualRows);
        }

        // ── FALLBACK: no orders, no prev day sales → use stock_details ──
        if (allStock.length > 0) {
          const virtualRows = allStock.map((stock, idx) => {
            const key4 = normKey4(stock.brandNumber, stock.brandName ?? "", stock.size, stock.quantityPerCase ?? 0);
            const orderKey = normKey2(stock.brandNumber, stock.size);
            const openingBalance = openingBalMapFull.get(key4) ?? 0;
            const orderAgg = orderNewStk.get(orderKey);
            const mrpOverride = findMrpOverride(stock.brandNumber, stock.size);
            const qtyPerCase = stock.quantityPerCase ?? 12;
            const newStockCases = orderAgg ? orderAgg.cases : 0;
            const newStockBottles = orderAgg ? orderAgg.bottles : 0;
            const mrpVal = mrpOverride ? mrpOverride.salesMrp : (stock.mrp || "0");
            return {
              id: -(idx + 1),
              brandNumber: stock.brandNumber,
              brandName: stock.brandName,
              size: stock.size,
              quantityPerCase: qtyPerCase,
              openingBalanceBottles: openingBalance,
              newStockCases,
              newStockBottles,
              closingBalanceCases: 0,
              closingBalanceBottles: 0,
              soldBottles: 0,
              mrp: mrpVal,
              saleValue: "0",
              totalSaleValue: "0",
              breakageBottles: 0,
              totalClosingStock: 0,
              finalClosingBalance: 0,
              saleDate: date,
              invoiceDate: stock.invoiceDate ?? null,
              isSubmitted: false,
              createdAt: null,
            };
          });
          return res.json(virtualRows);
        }
      }

      // Existing records — override opening balance (from historical sources only),
      // new stock, MRP, and qty-per-case (from order pack_size) from live sources.
      // If no historical source found, keep the value already stored in the DB record.
      const salesWithOverrides = sales.map((sale) => {
        const key4 = normKey4(sale.brandNumber, sale.brandName, sale.size, sale.quantityPerCase ?? 0);
        const orderKey = normKey2(sale.brandNumber, sale.size);
        const openingBalance = openingBalMapStrict.has(key4)
          ? openingBalMapStrict.get(key4)!
          : (sale.openingBalanceBottles ?? 0);
        const orderAgg = orderNewStk.get(orderKey);
        const mrpOverride = findMrpOverride(sale.brandNumber, sale.size);
        // Override qty/cs with value extracted from order pack_size (number before '/')
        // e.g. "48 / 180 ml" → 48. Falls back to stored value if no matching order.
        const qtyFromOrder = orderQtyMap.get(orderKey);
        const quantityPerCase = qtyFromOrder ?? (sale.quantityPerCase ?? 12);

        // Resolve MRP: sales_mrp_details override → stored sale.mrp (if non-zero) → stock_details.mrp fallback
        const storedMrp = parseFloat(sale.mrp as string);
        const resolvedMrp = mrpOverride
          ? mrpOverride.salesMrp
          : (!isNaN(storedMrp) && storedMrp > 0)
            ? sale.mrp
            : (findStockMrp(sale.brandNumber, sale.size) ?? sale.mrp ?? "0");

        return {
          ...sale,
          quantityPerCase,
          openingBalanceBottles: openingBalance,
          newStockCases: orderAgg ? orderAgg.cases : 0,
          newStockBottles: orderAgg ? orderAgg.bottles : 0,
          mrp: resolvedMrp,
        };
      });

      // Append virtual rows for orders whose brand+size have NO matching saved daily_sales row.
      // This handles: brand number changed after save, or new orders added after a date was saved.
      type OrderRowAgg2 = { brandNumber: string; brandName: string; size: string; packSize: string; cases: number; bottles: number };
      const orderRowMap2 = new Map<string, OrderRowAgg2>();
      for (const o of matchingOrders) {
        const sz = extractSizeFromPackSize(o.packSize);
        const k = normKey2(o.brandNumber, sz);
        const ex = orderRowMap2.get(k);
        if (ex) {
          ex.cases += o.qtyCasesDelivered ?? 0;
          ex.bottles += o.qtyBottlesDelivered ?? 0;
        } else {
          orderRowMap2.set(k, { brandNumber: o.brandNumber, brandName: o.brandName, size: sz, packSize: o.packSize, cases: o.qtyCasesDelivered ?? 0, bottles: o.qtyBottlesDelivered ?? 0 });
        }
      }
      const existingKeys = new Set(sales.map(s => normKey2(s.brandNumber, s.size)));
      const unmatchedVirtualRows: typeof salesWithOverrides = [];
      let vIdx = 0;
      for (const [, ord] of Array.from(orderRowMap2.entries())) {
        if (!existingKeys.has(normKey2(ord.brandNumber, ord.size))) {
          const mrpOv = findMrpOverride(ord.brandNumber, ord.size);
          const stk = allStock.find(s => normKey2(s.brandNumber, s.size) === normKey2(ord.brandNumber, ord.size));
          const mrpVal = mrpOv ? mrpOv.salesMrp as string : (stk?.mrp as string ?? "0");
          const qtyPc = extractQtyPerCaseFromPackSize(ord.packSize) || (stk?.quantityPerCase ?? 12);
          const key4 = normKey4(ord.brandNumber, ord.brandName, ord.size, qtyPc);
          const opBal = openingBalMapStrict.get(key4) ?? 0;
          unmatchedVirtualRows.push({
            id: -(vIdx + 1),
            brandNumber: ord.brandNumber,
            brandName: ord.brandName,
            size: ord.size,
            quantityPerCase: qtyPc,
            openingBalanceBottles: opBal,
            newStockCases: ord.cases,
            newStockBottles: ord.bottles,
            closingBalanceCases: 0,
            closingBalanceBottles: 0,
            soldBottles: 0,
            mrp: mrpVal,
            saleValue: "0",
            totalSaleValue: "0",
            breakageBottles: 0,
            totalClosingStock: 0,
            finalClosingBalance: 0,
            saleDate: date,
            invoiceDate: null,
            isSubmitted: false,
            createdAt: null,
          });
          vIdx++;
        }
      }

      return res.json([...salesWithOverrides, ...unmatchedVirtualRows]);
    }
    const sales = await storage.getDailySales();
    res.json(sales);
  });

  // Sales MRP overrides
  app.get("/api/sales-mrp", async (_req, res) => {
    const data = await storage.getSalesMrpDetails();
    res.json(data);
  });

  app.post("/api/sales-mrp", async (req, res) => {
    try {
      const { brandNumber, brandName, size, productType, salesMrp } = req.body;
      if (!brandNumber || !brandName || !size || !productType) {
        return res.status(400).json({ message: "brandNumber, brandName, size, and productType are required" });
      }
      if (parseFloat(salesMrp) < 0) {
        return res.status(400).json({ message: "salesMrp must not be less than 0" });
      }
      const result = await storage.upsertSalesMrpDetail({ brandNumber: padBrandNumber(brandNumber), brandName, size, productType, salesMrp: String(salesMrp) });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/sales-mrp/:id", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      const deleted = await storage.deleteSalesMrpDetail(id);
      if (!deleted) return res.status(404).json({ message: "Record not found" });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/sales-mrp", requireAdmin, async (req, res) => {
    try {
      const schema = z.object({ ids: z.array(z.number().int().positive()) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Invalid ids array" });
      const { ids } = parsed.data;
      const results = await Promise.all(ids.map(id => storage.deleteSalesMrpDetail(id)));
      const deleted = results.filter(Boolean).length;
      res.json({ success: true, deleted });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Bulk upload Sales MRP from Excel
  app.post("/api/sales-mrp/bulk-upload", requireAdmin, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded." });
      const ext = req.file.originalname.toLowerCase().split(".").pop() || "";
      if (!["xls", "xlsx", "csv"].includes(ext)) {
        return res.status(400).json({ message: "Please upload an .xls, .xlsx, or .csv file." });
      }

      const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: false });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonRows: Record<string, any>[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      if (jsonRows.length === 0) return res.status(400).json({ message: "File is empty or has no data rows." });

      // Normalise column name to field key
      const norm = (s: string) => String(s).toLowerCase().replace(/[\s_\-:.]/g, "");
      const COL_MAP: Record<string, string> = {
        brandnumber: "brandNumber", brandno: "brandNumber",
        brandname: "brandName",
        size: "size",
        salesmrp: "salesMrp", mrp: "salesMrp", salesprice: "salesMrp",
        producttype: "productType", type: "productType",
      };

      const rows: { brandNumber: string; brandName: string; size: string; salesMrp: string; productType: string }[] = [];
      const skipped: number[] = [];

      for (let i = 0; i < jsonRows.length; i++) {
        const raw = jsonRows[i];
        const mapped: Record<string, string> = {};
        for (const [col, val] of Object.entries(raw)) {
          const key = COL_MAP[norm(col)];
          if (key) mapped[key] = String(val ?? "").trim();
        }

        const { brandNumber = "", brandName = "", size = "", salesMrp = "", productType = "" } = mapped;
        if (!brandNumber || !brandName || !size) { skipped.push(i + 2); continue; } // +2 → Excel row number
        const mrpNum = parseFloat(salesMrp.replace(/,/g, ""));
        rows.push({
          brandNumber: padBrandNumber(brandNumber),
          brandName,
          size,
          salesMrp: isNaN(mrpNum) ? "0" : mrpNum.toFixed(2),
          productType,
        });
      }

      if (rows.length === 0) return res.status(400).json({ message: "No valid rows found. Ensure columns brand_number, brand_name, size are present." });

      // Deduplicate: keep last occurrence of each (brandNumber, brandName, size, productType) key
      const deduped = Array.from(
        rows.reduce((map, row) => {
          const key = `${row.brandNumber}|${row.brandName}|${row.size}|${row.productType}`;
          map.set(key, row);
          return map;
        }, new Map<string, typeof rows[number]>()).values()
      );

      const saved = await storage.bulkUpsertSalesMrpDetails(deduped);
      res.json({
        message: `${saved} Sales MRP record(s) imported successfully.${skipped.length > 0 ? ` Skipped ${skipped.length} row(s) missing required fields (rows: ${skipped.join(", ")}).` : ""}`,
        saved,
        skipped: skipped.length,
      });
    } catch (err: any) {
      res.status(500).json({ message: "Failed to import: " + err.message });
    }
  });

  // Import archive / historical daily sales from Excel
  app.post("/api/sales/import-archive", requireAdmin, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded." });
      const ext = req.file.originalname.toLowerCase().split(".").pop() || "";
      if (!["xls", "xlsx"].includes(ext)) {
        return res.status(400).json({ message: "Please upload an .xls or .xlsx file." });
      }

      const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: false });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonRows: Record<string, any>[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      if (jsonRows.length === 0) return res.status(400).json({ message: "File is empty or has no data rows." });

      // Build MRP lookup from stock_details (fallback) and sales_mrp_details (override)
      const allStock = await storage.getStockDetails();
      const allMrp   = await storage.getSalesMrpDetails();
      const mrpMap = new Map<string, string>();
      for (const s of allStock)  mrpMap.set(`${s.brandNumber}|${s.size}`, String(s.mrp ?? "0"));
      for (const m of allMrp)    mrpMap.set(`${m.brandNumber}|${m.size}`,  String(m.salesMrp ?? "0"));

      // Excel date serial → YYYY-MM-DD
      const toDateStr = (raw: any): string | null => {
        if (raw === undefined || raw === null || raw === "") return null;
        if (typeof raw === "number") {
          // Excel stores dates as days since 1900-01-00 (with a 1900 leap-year bug)
          const utcMs = (raw - 25569) * 86400 * 1000;
          const d = new Date(utcMs);
          if (isNaN(d.getTime())) return null;
          const yyyy = d.getUTCFullYear();
          const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
          const dd = String(d.getUTCDate()).padStart(2, "0");
          return `${yyyy}-${mm}-${dd}`;
        }
        const s = String(raw).trim();
        // Try DD/MM/YYYY or DD-MM-YYYY
        const ddmm = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
        if (ddmm) return `${ddmm[3]}-${ddmm[2].padStart(2,"0")}-${ddmm[1].padStart(2,"0")}`;
        // Try YYYY-MM-DD or YYYY/MM/DD
        const iso = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
        if (iso) return `${iso[1]}-${iso[2].padStart(2,"0")}-${iso[3].padStart(2,"0")}`;
        return null;
      };

      const norm = (s: string) => String(s).toLowerCase().replace(/[\s_\-:.()\\/]/g, "");
      const COL: Record<string, string> = {
        saledate: "saleDate", date: "saleDate",
        brandno: "brandNumber", brandnumber: "brandNumber",
        brandname: "brandName",
        size: "size",
        qtycase: "qtyPerCase", qtypecase: "qtyPerCase", qtypercase: "qtyPerCase",
        openingbalbtls: "openingBal", openingbalancebtls: "openingBal", openingbaltbtls: "openingBal",
        opbalbtls: "openingBal",
        newstockcs: "newStockCs", newstockcases: "newStockCs",
        newstockbtls: "newStockBtls", newstockbottles: "newStockBtls",
        totalstock: "totalStock",
        clsbalcs: "clsCs", clsbalancecs: "clsCs", closingbalcs: "clsCs",
        clsbalbtls: "clsBtls", clsbalancebtls: "clsBtls", closingbalbtls: "clsBtls",
        breakage: "breakage", breakagebottles: "breakage",
        invoicedate: "invoiceDate",
      };

      const rows: any[] = [];
      const skipped: number[] = [];

      for (let i = 0; i < jsonRows.length; i++) {
        const raw = jsonRows[i];
        const m: Record<string, any> = {};
        for (const [col, val] of Object.entries(raw)) {
          const key = COL[norm(col)];
          if (key) m[key] = val;
        }

        const saleDate = toDateStr(m.saleDate);
        const brandNumber = String(m.brandNumber ?? "").trim();
        const brandName   = String(m.brandName   ?? "").trim();
        const size        = String(m.size         ?? "").trim();
        const qtyPerCase  = parseInt(m.qtyPerCase ?? 0, 10) || 0;

        if (!saleDate || !brandNumber || !brandName || !size || !qtyPerCase) {
          skipped.push(i + 2);
          continue;
        }

        const opBal    = parseInt(m.openingBal   ?? 0, 10) || 0;
        const newCs    = parseInt(m.newStockCs   ?? 0, 10) || 0;
        const newBtls  = parseInt(m.newStockBtls ?? 0, 10) || 0;
        const clsCs    = parseInt(m.clsCs        ?? 0, 10) || 0;
        const clsBtls  = parseInt(m.clsBtls      ?? 0, 10) || 0;
        const breakage = parseInt(m.breakage      ?? 0, 10) || 0;
        const invDate  = toDateStr(m.invoiceDate);

        const paddedBrand = brandNumber.padStart(4, "0");
        const totalStock   = opBal + (qtyPerCase * newCs) + newBtls;
        const closingTotal = (clsCs * qtyPerCase) + clsBtls;
        const soldBottles  = totalStock - closingTotal;
        const mrp          = parseFloat(mrpMap.get(`${paddedBrand}|${size}`) ?? mrpMap.get(`${brandNumber}|${size}`) ?? "0") || 0;
        const saleValue    = soldBottles > 0 ? (soldBottles * mrp) : 0;

        rows.push({
          brandNumber: paddedBrand,
          brandName,
          size,
          quantityPerCase: qtyPerCase,
          openingBalanceBottles: opBal,
          newStockCases: newCs,
          newStockBottles: newBtls,
          closingBalanceCases: clsCs,
          closingBalanceBottles: clsBtls,
          breakageBottles: breakage,
          soldBottles: Math.max(0, soldBottles),
          saleValue: saleValue.toFixed(2),
          totalSaleValue: saleValue.toFixed(2),
          totalClosingStock: closingTotal,
          finalClosingBalance: Math.max(0, closingTotal - breakage),
          mrp: mrp.toFixed(2),
          saleDate,
          invoiceDate: invDate ?? null,
          isSubmitted: false,
        });
      }

      if (rows.length === 0) {
        return res.status(400).json({ message: `No valid rows found. Skipped: ${skipped.length}. Ensure required columns are present.` });
      }

      const saved = await storage.bulkImportDailySales(rows);
      res.json({
        message: `${saved} row(s) imported successfully.${skipped.length > 0 ? ` Skipped ${skipped.length} row(s) with missing required fields.` : ""}`,
        saved,
        skipped: skipped.length,
      });
    } catch (err: any) {
      res.status(500).json({ message: "Import failed: " + err.message });
    }
  });

  app.get(api.sales.isSubmitted.path, async (req, res) => {
    const date = req.query.date as string | undefined;
    if (!date) {
      return res.status(400).json({ message: "date query parameter is required" });
    }
    const isSubmitted = await storage.isSalesSubmittedForDate(date);
    res.json({ isSubmitted });
  });

  app.post(api.sales.submit.path, async (req, res) => {
    try {
      const { date } = api.sales.submit.input.parse(req.body);
      const isAdmin = (req.user as any)?.role === "admin";
      const alreadySubmitted = await storage.isSalesSubmittedForDate(date);
      // Employee: block re-submission. Admin: allow re-submission (just re-marks as submitted)
      if (alreadySubmitted && !isAdmin) {
        return res.status(400).json({ message: "Sales for this date are already submitted." });
      }
      const submittedCount = await storage.submitSalesForDate(date);
      res.json({ submittedCount, alreadySubmitted });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: err.errors[0].message });
      }
      throw err;
    }
  });

  app.post(api.sales.bulkUpdate.path, async (req, res) => {
    try {
      const { rows: input, deleteIds } = api.sales.bulkUpdate.input.parse(req.body);
      const date = req.query.date as string | undefined;
      const isAdmin = (req.user as any)?.role === "admin";

      // Resolve effective date: use provided date or default to today
      const effectiveDate = date || new Date().toISOString().split('T')[0];

      // Employees cannot re-save after a date has been submitted; admins always can.
      if (!isAdmin) {
        const alreadySubmitted = await storage.isSalesSubmittedForDate(effectiveDate);
        if (alreadySubmitted) {
          return res.status(403).json({ message: "Sales for this date are already submitted and cannot be edited." });
        }
      }

      // Delete pending-delete rows first (capture their data before deleting for stock revert)
      if (deleteIds && deleteIds.length > 0) {
        await storage.deleteAndRevertSales(deleteIds, effectiveDate);
      }

      // Admin can always re-save, even after a date has been "submitted".
      let result: DailySale[];
      if (date) {
        result = await storage.bulkUpdateDailySalesForDate(input, date);
      } else {
        result = await storage.bulkUpdateDailySales(input);
      }

      // Sync stock for the saved date — updates stock_details from current daily_sales closing values
      const stockSync = await storage.syncDailySalesToStock(effectiveDate);
      console.log(
        `Stock sync from sales save (${effectiveDate}): ${stockSync.updatedStockCount} stock rows updated`,
      );

      // Full-replace daily_stock snapshot for the date so deleted rows are removed from it too
      await storage.replaceFullDailyStockSnapshot(effectiveDate);
      console.log(`Daily stock snapshot (full replace) saved for date ${effectiveDate}`);

      res.status(201).json(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join("."),
        });
      }
      throw err;
    }
  });


  // Delete a single daily_sales row by ID (admin only)
  app.delete("/api/sales/:id", requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    await storage.deleteDailySale(id);
    res.json({ success: true });
  });

  // Bulk delete sales records
  app.delete("/api/sales", requireAdmin, async (req, res) => {
    try {
      const schema = z.object({ ids: z.array(z.number().int().positive()) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Invalid ids array" });
      const { ids } = parsed.data;
      await Promise.all(ids.map(id => storage.deleteDailySale(id)));
      res.json({ success: true, deleted: ids.length });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Returns all distinct dates that have a daily_stock snapshot (YYYY-MM-DD[])
  app.get("/api/daily-stock/available-dates", requireAuth, async (_req, res) => {
    try {
      const dates = await storage.getAvailableStockDates();
      res.json({ dates });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch available stock dates" });
    }
  });

  // Daily stock by date
  app.get("/api/daily-stock", async (req, res) => {
    const date = req.query.date as string | undefined;
    if (!date) return res.status(400).json({ message: "date query parameter is required" });
    const result = await storage.getDailyStockByDate(date);
    res.json(result);
  });

  // Lightweight brand→productType map used by the Sales page (avoids fetching all orders)
  app.get("/api/orders/brand-types", async (_req, res) => {
    try {
      const data = await storage.getBrandTypes();
      res.json(data);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch brand types" });
    }
  });

  // Check if invoice already exists by invoice_date + icdc_number
  app.get("/api/orders/check-invoice", async (req, res) => {
    const invoiceDate = req.query.invoice_date as string | undefined;
    const icdcNumber = req.query.icdc_number as string | undefined;
    if (!invoiceDate && !icdcNumber) {
      return res.json({ exists: false });
    }
    const allOrders = await storage.getOrders();
    const exists = allOrders.some((o) => {
      if (invoiceDate && icdcNumber) {
        return o.invoiceDate === invoiceDate && o.icdcNumber === icdcNumber;
      }
      if (invoiceDate) return o.invoiceDate === invoiceDate;
      if (icdcNumber) return o.icdcNumber === icdcNumber;
      return false;
    });
    res.json({ exists, invoiceDate, icdcNumber });
  });

  // Orders
  app.get(api.orders.list.path, async (req, res) => {
    const invoiceDate = req.query.invoice_date as string | undefined;
    const icdcNumber = req.query.icdc_number as string | undefined;
    const brandNumber = req.query.brand_number as string | undefined;
    const allOrders = await storage.getOrders();
    let filtered = allOrders;
    if (invoiceDate) {
      filtered = filtered.filter((o) => o.invoiceDate === invoiceDate);
    }
    if (icdcNumber) {
      filtered = filtered.filter((o) => o.icdcNumber === icdcNumber);
    }
    if (brandNumber) {
      const search = brandNumber.trim();
      filtered = filtered.filter((o) => o.brandNumber.includes(search));
    }
    res.json(filtered);
  });

  app.post(api.orders.bulkCreate.path, requireAdmin, async (req, res) => {
    try {
      const input = api.orders.bulkCreate.input.parse(req.body);
      // Normalize invoiceDate to ISO YYYY-MM-DD before storing (date column requires it)
      const normalized = input.map(order => ({
        ...order,
        invoiceDate: order.invoiceDate ? (normalizeInvoiceDate(order.invoiceDate) ?? null) : null,
      }));
      const result = await storage.bulkCreateOrders(normalized);
      // Orders are stored only — stock is updated exclusively from "Save Sales"
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join("."),
        });
      }
      throw err;
    }
  });

  // Update a single order
  app.put("/api/orders/:id", requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid order id" });
    try {
      const updated = await storage.updateOrder(id, req.body);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to update order" });
    }
  });

  // Delete a single order
  app.delete("/api/orders/:id", requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid order id" });
    try {
      await storage.deleteOrder(id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to delete order" });
    }
  });

  // Stock
  app.get(api.stock.list.path, async (req, res) => {
    const stock = await storage.getStockDetails();
    res.json(stock);
  });

  app.post(api.stock.bulkUpdate.path, requireAdmin, async (req, res) => {
    try {
      const input = api.stock.bulkUpdate.input.parse(req.body);
      const result = await storage.bulkUpdateStockDetails(input);

      const salesSync = await storage.syncStockToDailySales();
      console.log(
        `Sales sync (from stock update): ${salesSync.updatedSalesCount} updated, ${salesSync.createdSalesCount} created in daily sales`,
      );

      res.status(201).json(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join("."),
        });
      }
      throw err;
    }
  });


  app.get("/api/sales/all", async (_req, res) => {
    try {
      const sales = await storage.getDailySales();
      res.json(sales);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch sales records" });
    }
  });

  app.get("/api/sales/earliest-invoice-date", async (_req, res) => {
    try {
      const raw = await storage.getEarliestInvoiceDate();
      const date = raw instanceof Date ? raw.toISOString().split("T")[0] : raw;
      res.json({ invoiceDate: date });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch earliest invoice date" });
    }
  });

  // Returns all distinct sale dates that have data in daily_sales (YYYY-MM-DD[])
  app.get("/api/sales/available-dates", requireAuth, async (_req, res) => {
    try {
      const dates = await storage.getAvailableSalesDates();
      res.json({ dates });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch available sales dates" });
    }
  });

  // Returns the latest distinct invoice_date from the orders table (YYYY-MM-DD)
  app.get("/api/orders/latest-invoice-date", async (_req, res) => {
    try {
      const raw = await storage.getLatestOrderInvoiceDate();
      const date = raw instanceof Date ? raw.toISOString().split("T")[0] : raw;
      res.json({ invoiceDate: date });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch latest order invoice date" });
    }
  });

  // Returns the earliest distinct invoice_date from the orders table (YYYY-MM-DD)
  app.get("/api/orders/earliest-invoice-date", async (_req, res) => {
    try {
      const raw = await storage.getEarliestOrderInvoiceDate();
      const date = raw instanceof Date ? raw.toISOString().split("T")[0] : raw;
      res.json({ invoiceDate: date });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch earliest order invoice date" });
    }
  });

  app.get("/api/sales/summary", async (req, res) => {
    try {
      const date = (req.query.date as string) || new Date().toISOString().split("T")[0];

      // Today's sales for the requested date
      const todaySales = await storage.getDailySalesByDate(date);

      // Previous day's sales — for Opening Balance Value
      const prevDate = new Date(date);
      prevDate.setDate(prevDate.getDate() - 1);
      const prevDateStr = prevDate.toISOString().split("T")[0];
      const prevSales = await storage.getDailySalesByDate(prevDateStr);

      // Opening Balance Value = sum of D-1's (finalClosingBalance bottles × MRP)
      const openingBalanceValue = prevSales.reduce(
        (acc, s) => {
          const bottles = (s.finalClosingBalance as number) || 0;
          const mrp = parseFloat(s.mrp as string) || 0;
          return acc + bottles * mrp;
        },
        0
      );

      const brandTypes = await storage.getBrandTypes();
      const orderTypeMap: Record<string, string> = {};
      for (const o of brandTypes) {
        orderTypeMap[o.brandNumber] = o.productType;
      }

      let newStockValue = 0;
      let soldStockValue = 0;

      const categories: Record<string, { opening: number; newStock: number; sold: number; closing: number }> = {};

      for (const s of todaySales) {
        const mrp = parseFloat(s.mrp as string) || 0;
        const qtyPerCase = s.quantityPerCase || 0;
        const opBal = s.openingBalanceBottles || 0;
        const newCs = s.newStockCases || 0;
        const newBtls = s.newStockBottles || 0;
        const soldBtls = s.soldBottles || 0;
        const totalClosing = s.totalClosingStock || 0;

        // New Stock in bottles = Total Stk - Op. Bal (Btls) = newStockCases * qty + newStockBottles
        const newStockBottlesCalc = (newCs * qtyPerCase) + newBtls;

        // New Stock Value = MRP × (Total Stk − Op. Bal Btls)
        newStockValue += newStockBottlesCalc * mrp;
        soldStockValue += soldBtls * mrp;

        const pType = orderTypeMap[s.brandNumber] || "Other";
        if (!categories[pType]) {
          categories[pType] = { opening: 0, newStock: 0, sold: 0, closing: 0 };
        }
        categories[pType].opening += opBal;
        categories[pType].newStock += newStockBottlesCalc;
        categories[pType].sold += soldBtls;
        categories[pType].closing += totalClosing;
      }

      // Closing Balance Value = Opening + New Stock - Sold Stock
      const closingBalanceValue = openingBalanceValue + newStockValue - soldStockValue;

      res.json({
        openingBalanceValue,
        newStockValue,
        soldStockValue,
        closingBalanceValue,
        categories,
      });
    } catch (err: any) {
      res.status(500).json({ message: "Failed to compute sales summary: " + err.message });
    }
  });

  // ONE-TIME data export: generates a SQL file to migrate data to another database
  app.get("/api/admin/export-data", requireAdmin, async (_req, res) => {
    try {
      const tables = [
        { name: "shop_details", conflict: "(id)" },
        { name: "orders", conflict: "(id)" },
        { name: "stock_details", conflict: "(id)" },
        { name: "daily_sales", conflict: "(id)" },
        { name: "daily_stock", conflict: "(id)" },
        { name: "sales_mrp_details", conflict: "(id)" },
      ];

      let sql = `-- BRR Liquor Soft Data Export\n-- Generated: ${new Date().toISOString()}\n-- Run this on your target database\n\n`;

      for (const { name, conflict } of tables) {
        const result = await pool.query(`SELECT * FROM ${name} ORDER BY id`);
        if (result.rows.length === 0) {
          sql += `-- ${name}: no data\n\n`;
          continue;
        }

        const cols = result.fields.map((f) => `"${f.name}"`).join(", ");
        sql += `-- ${name} (${result.rows.length} rows)\n`;

        for (const row of result.rows) {
          const vals = result.fields.map((f) => {
            const v = row[f.name];
            if (v === null || v === undefined) return "NULL";
            if (typeof v === "number" || typeof v === "boolean") return String(v);
            if (v instanceof Date) return `'${v.toISOString()}'`;
            return `'${String(v).replace(/'/g, "''")}'`;
          }).join(", ");
          sql += `INSERT INTO ${name} (${cols}) VALUES (${vals}) ON CONFLICT ${conflict} DO NOTHING;\n`;
        }
        sql += `\n`;
      }

      res.setHeader("Content-Type", "text/plain");
      res.setHeader("Content-Disposition", `attachment; filename="brr_export_${new Date().toISOString().slice(0, 10)}.sql"`);
      res.send(sql);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/shop-details", async (_req, res) => {
    try {
      const details = await storage.getShopDetails();
      res.json(details);
    } catch (err: any) {
      res.status(500).json({ message: "Failed to fetch shop details: " + err.message });
    }
  });

  app.get("/api/shop-details/by-license/:licenseNo", async (req, res) => {
    try {
      const detail = await storage.getShopDetailByLicenseNo(req.params.licenseNo);
      if (!detail) {
        return res.status(404).json({ message: "No shop details found for this license number" });
      }
      res.json(detail);
    } catch (err: any) {
      res.status(500).json({ message: "Failed to fetch shop details: " + err.message });
    }
  });

  app.get("/api/shop-details/by-icdc/:icdcNumber", async (req, res) => {
    try {
      const detail = await storage.getShopDetailByIcdcNumber(req.params.icdcNumber);
      if (!detail) {
        return res.status(404).json({ message: "No shop details found for this ICDC number" });
      }
      res.json(detail);
    } catch (err: any) {
      res.status(500).json({ message: "Failed to fetch shop details: " + err.message });
    }
  });

  app.get("/api/mrp-template/download", (_req, res) => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ["brand_number", "brand_name", "size", "sales_mrp", "product_type", "note"],
      ["0019", "Kingfisher", "650ml", "110", "Beer", "← EXAMPLE ROW (delete before importing)"],
      ["0042", "Royal Challenge", "750ml", "250", "Whisky", "← EXAMPLE ROW (delete before importing)"],
    ]);
    ws["!cols"] = [
      { wch: 15 },
      { wch: 20 },
      { wch: 10 },
      { wch: 12 },
      { wch: 15 },
      { wch: 40 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, "MRP Template");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Disposition", "attachment; filename=MRP_Import_Template.xlsx");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buf);
  });

  app.get("/api/template/download", (req, res) => {
    const format = (req.query.format as string) || "pdf";

    if (format === "pdf") {
      const pdfPath = path.resolve(
        "attached_assets/sample_Invoice_Templates_1770376466401.pdf",
      );
      if (!fs.existsSync(pdfPath)) {
        return res.status(404).json({ message: "Template PDF not found" });
      }
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=Invoice_Template_Sample.pdf",
      );
      res.setHeader("Content-Type", "application/pdf");
      fs.createReadStream(pdfPath).pipe(res);
      return;
    }

    const xlsxPath = path.resolve(
      "attached_assets/Invoice_Template_1775231757722.xlsx",
    );
    if (!fs.existsSync(xlsxPath)) {
      return res.status(404).json({ message: "Template Excel file not found" });
    }
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=Invoice_Template.xlsx",
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    fs.createReadStream(xlsxPath).pipe(res);
  });

  // Upload
  app.post(api.upload.create.path, upload.single("file"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const allowedExts = [".csv", ".xls", ".xlsx", ".pdf"];
    const ext =
      "." + (req.file.originalname.toLowerCase().split(".").pop() || "");
    if (!allowedExts.includes(ext)) {
      return res
        .status(400)
        .json({ message: "Please upload a .csv, .xls, .xlsx, or .pdf file." });
    }

    try {
      const result = await parseUploadedFile(
        req.file.buffer,
        req.file.originalname,
      );

      if (result.shopDetail) {
        try {
          await storage.createShopDetail(result.shopDetail as any);
        } catch (shopErr: any) {
          console.error("Failed to save shop details:", shopErr.message);
        }
      }

      const skipped = result.skippedLines ?? [];
      const skippedMsg = skipped.length > 0
        ? ` Warning: ${skipped.length} row(s) could not be parsed (unrecognised size format): ${skipped.join(" | ")}`
        : "";
      res.json({
        message: `Successfully parsed ${result.orders.length} order(s) from "${req.file.originalname}".${skippedMsg} Please review and confirm before saving.`,
        filename: req.file.originalname,
        orders: result.orders,
        ordersCount: result.orders.length,
        shopDetail: result.shopDetail,
        skippedCount: skipped.length,
        skippedLines: skipped,
      });
    } catch (err: any) {
      res.status(500).json({ message: "Failed to parse file: " + err.message });
    }
  });

  // Seed Data - retry on DB cold start
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await seedDatabase();
      break;
    } catch (err: any) {
      console.error(
        `Seed attempt ${attempt}/${maxRetries} failed: ${err.message}`,
      );
      if (attempt === maxRetries) {
        console.error(
          "Seeding failed after retries, continuing without seed data",
        );
      } else {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  // ── Reports APIs ──────────────────────────────────────────────────────
  app.get("/api/reports/sales", async (_req, res) => {
    try {
      const [trendRows, kpiRows, topByBottles, topByValue] = await Promise.all([
        pool.query(`
          SELECT
            sale_date::text AS date,
            SUM(sold_bottles)::int            AS total_bottles_sold,
            ROUND(SUM(sale_value::numeric),2) AS total_revenue,
            COUNT(DISTINCT brand_number)::int AS brands_count,
            BOOL_OR(is_submitted)             AS is_submitted
          FROM daily_sales
          GROUP BY sale_date
          ORDER BY sale_date ASC
        `),
        pool.query(`
          SELECT
            ROUND(SUM(sale_value::numeric),2)   AS total_revenue,
            SUM(sold_bottles)::int               AS total_bottles_sold,
            COUNT(DISTINCT sale_date)::int        AS total_days,
            MAX(sale_date)::text                  AS latest_date,
            ROUND(MAX(daily_total),2)             AS best_day_revenue,
            (SELECT sale_date::text FROM (
              SELECT sale_date, SUM(sale_value::numeric) daily_total
              FROM daily_sales GROUP BY sale_date ORDER BY daily_total DESC LIMIT 1
            ) t2)                                 AS best_day_date
          FROM daily_sales,
               LATERAL (SELECT SUM(sale_value::numeric) daily_total
                         FROM daily_sales d2 WHERE d2.sale_date = daily_sales.sale_date) _lat
        `),
        pool.query(`
          SELECT brand_number, brand_name, size,
                 SUM(sold_bottles)::int               AS sold,
                 ROUND(SUM(sale_value::numeric),2)    AS value
          FROM daily_sales
          GROUP BY brand_number, brand_name, size
          ORDER BY sold DESC LIMIT 10
        `),
        pool.query(`
          SELECT brand_number, brand_name, size,
                 SUM(sold_bottles)::int               AS sold,
                 ROUND(SUM(sale_value::numeric),2)    AS value
          FROM daily_sales
          GROUP BY brand_number, brand_name, size
          ORDER BY value DESC LIMIT 10
        `),
      ]);
      res.json({
        kpi: kpiRows.rows[0] || {},
        trend: trendRows.rows,
        topBrandsByBottles: topByBottles.rows,
        topBrandsByValue: topByValue.rows,
      });
    } catch (err: any) {
      console.error("Sales report error:", err.message);
      res.status(500).json({ message: "Failed to generate sales report" });
    }
  });

  app.get("/api/reports/stock", async (_req, res) => {
    try {
      const [trendRows, kpiRows, topByValue, topByBottles] = await Promise.all([
        pool.query(`
          SELECT
            date::text                              AS date,
            SUM(total_stock_bottles)::int           AS total_bottles,
            ROUND(SUM(total_stock_value::numeric),2) AS total_value
          FROM daily_stock
          GROUP BY date
          ORDER BY date ASC
        `),
        pool.query(`
          SELECT
            (SELECT ROUND(SUM(total_stock_value::numeric),2) FROM daily_stock
             WHERE date = (SELECT MAX(date) FROM daily_stock)) AS latest_total_value,
            (SELECT SUM(total_stock_bottles)::int FROM daily_stock
             WHERE date = (SELECT MAX(date) FROM daily_stock)) AS latest_total_bottles,
            COUNT(DISTINCT date)::int                           AS total_dates,
            MAX(date)::text                                     AS latest_date,
            MIN(date)::text                                     AS earliest_date
          FROM daily_stock
        `),
        pool.query(`
          SELECT brand_number, brand_name, size,
                 total_stock_bottles                             AS bottles,
                 ROUND(total_stock_value::numeric,2)            AS value
          FROM daily_stock
          WHERE date = (SELECT MAX(date) FROM daily_stock)
          ORDER BY value DESC LIMIT 10
        `),
        pool.query(`
          SELECT brand_number, brand_name, size,
                 total_stock_bottles                             AS bottles,
                 ROUND(total_stock_value::numeric,2)            AS value
          FROM daily_stock
          WHERE date = (SELECT MAX(date) FROM daily_stock)
          ORDER BY bottles DESC LIMIT 10
        `),
      ]);
      res.json({
        kpi: kpiRows.rows[0] || {},
        trend: trendRows.rows,
        topBrandsByValue: topByValue.rows,
        topBrandsByBottles: topByBottles.rows,
      });
    } catch (err: any) {
      console.error("Stock report error:", err.message);
      res.status(500).json({ message: "Failed to generate stock report" });
    }
  });

  // ─── Expense Categories ───────────────────────────────────────────────────
  app.get("/api/expense-categories", async (req, res) => {
    const type = req.query.type as string | undefined;
    const categories = await storage.getExpenseCategories(type);
    res.json(categories);
  });

  app.post("/api/expense-categories", requireAdmin, async (req, res) => {
    const { name, type } = req.body;
    if (!name || !type) return res.status(400).json({ message: "name and type are required" });
    if (!["expense", "income"].includes(type)) return res.status(400).json({ message: "type must be expense or income" });
    const trimmed = (name as string).trim();
    if (!trimmed) return res.status(400).json({ message: "name cannot be empty" });
    try {
      const created = await storage.createExpenseCategory({ name: trimmed, type });
      res.json(created);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/expense-categories/:id", requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });
    const deleted = await storage.deleteExpenseCategory(id);
    if (!deleted) return res.status(404).json({ message: "Not found" });
    res.json({ success: true });
  });

  // ─── Daily Expenses ───────────────────────────────────────────────────────
  app.get("/api/daily-expenses", async (req, res) => {
    const date = req.query.date as string;
    if (!date) return res.status(400).json({ message: "date is required" });
    const entries = await storage.getDailyExpenses(date);
    res.json(entries);
  });

  app.post("/api/daily-expenses", async (req, res) => {
    const { date, type, category, amount, description, paymentMode } = req.body;
    if (!date || !type || !category || amount === undefined || !paymentMode)
      return res.status(400).json({ message: "date, type, category, amount, and paymentMode are required" });
    if (!["expense", "income"].includes(type)) return res.status(400).json({ message: "type must be expense or income" });
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount < 0) return res.status(400).json({ message: "amount must be a non-negative number" });
    const submittedBy = (req.user as any)?.username || "unknown";
    try {
      const created = await storage.createDailyExpense({ date, type, category, amount: String(parsedAmount), description: description || null, paymentMode, submittedBy });
      res.json(created);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.put("/api/daily-expenses/:id", requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });
    const { type, category, amount, description, paymentMode } = req.body;
    const updates: Record<string, any> = {};
    if (type !== undefined) updates.type = type;
    if (category !== undefined) updates.category = category;
    if (amount !== undefined) updates.amount = String(parseFloat(amount));
    if (description !== undefined) updates.description = description;
    if (paymentMode !== undefined) updates.paymentMode = paymentMode;
    try {
      const updated = await storage.updateDailyExpense(id, updates);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/daily-expenses/:id", requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });
    const deleted = await storage.deleteDailyExpense(id);
    if (!deleted) return res.status(404).json({ message: "Not found" });
    res.json({ success: true });
  });

  return httpServer;
}

// Bootstraps the canonical application users on first startup.
// Each entry is created only if that username does not already exist —
// the seed is fully idempotent and safe to run on every restart.
// Passwords are fixed per-deployment (set here); operators should change
// them after first login using the in-app Reset Password feature.
async function seedDatabase() {
  // Canonical users for this deployment. Each is only created once.
  // If the user already exists (by username) it is left completely untouched.
  const SEED_USERS: Array<{ username: string; password: string; role: "admin" | "employee" }> = [
    { username: "balajiadmin",    password: "Brr@2026",      role: "admin"    },
    { username: "balajisaleman",  password: "BrrSales@2026", role: "employee" },
    { username: "balajisaleman1", password: "BrrSales@2026", role: "employee" },
  ];

  for (const { username, password, role } of SEED_USERS) {
    const existing = await storage.getUserByUsername(username);
    if (existing) continue;
    const hashed = await bcrypt.hash(password, 10);
    await storage.createUser({
      username,
      password: hashed,
      role,
      tempPassword: null,
      mustResetPassword: false,
      passwordChangedAt: new Date(),
    });
    logger.info(`Seeded user "${username}" (${role}).`);
  }
}
