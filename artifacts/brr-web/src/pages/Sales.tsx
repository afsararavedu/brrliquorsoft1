import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import { useSales, useBulkUpdateSales, useSubmitSales, useSalesIsSubmitted } from "@/hooks/use-sales";
import {
  Search,
  Save,
  Loader2,
  Download,
  Upload,
  FileSpreadsheet,
  Store,
  Lock,
  CheckCircle,
  Send,
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Trash2,
  Check,
  X,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  ChevronDown,
  Mic,
  MicOff,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type DailySale, type ShopDetail } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { PaginationCustom } from "@/components/ui/pagination-custom";
import { apiRequest } from "@/lib/queryClient";
import { queryClient } from "@/lib/queryClient";
import { useQuery } from "@tanstack/react-query";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { format, parse, subDays } from "date-fns";
import { useAuth } from "@/hooks/use-auth";
import { useSpeechSales } from "@/hooks/use-speech-sales";

interface SalesSummary {
  openingBalanceValue: number;
  newStockValue: number;
  soldStockValue: number;
  closingBalanceValue: number;
  categories: Record<string, { opening: number; newStock: number; sold: number; closing: number }>;
}

function getTodayLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Parses a "YYYY-MM-DD" string as LOCAL midnight (not UTC).
// new Date("YYYY-MM-DD") is UTC midnight — wrong in any timezone behind UTC.
function parseDateLocal(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Formats a local Date back to "YYYY-MM-DD" string.
function formatDateLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default function Sales() {
  const [selectedDate, setSelectedDate] = useState<string>(getTodayLocal());
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportFromDate, setExportFromDate] = useState<string>(getTodayLocal());
  const [exportToDate, setExportToDate] = useState<string>(getTodayLocal());
  const [exportFromPickerOpen, setExportFromPickerOpen] = useState(false);
  const [exportToPickerOpen, setExportToPickerOpen] = useState(false);

  const { data: sales, isLoading } = useSales(selectedDate);
  const { mutate: updateSales, isPending: isSaving } = useBulkUpdateSales();
  const { mutate: submitSales, isPending: isSubmitting } = useSubmitSales();
  const { data: submissionStatus } = useSalesIsSubmitted(selectedDate);
  const isSubmitted = submissionStatus?.isSubmitted ?? false;

  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  // Admin: any date up to today. Employee: last 7 days only.
  const isDateAllowedForAction = (() => {
    const today = getTodayLocal();
    if (selectedDate > today) return false;
    if (isAdmin) return true;
    const sevenDaysAgo = format(subDays(new Date(), 6), "yyyy-MM-dd");
    return selectedDate >= sevenDaysAgo;
  })();

  const { toast } = useToast();
  const [localSales, setLocalSales] = useState<DailySale[]>([]);

  const { data: shopDetails } = useQuery<ShopDetail[]>({
    queryKey: ["/api/shop-details"],
  });

  // Brand→productType map — lightweight endpoint (no full order data needed)
  const { data: brandTypes } = useQuery<{ brandNumber: string; productType: string }[]>({
    queryKey: ["/api/orders/brand-types"],
    staleTime: 300_000, // 5 minutes — changes only when new orders are imported
  });
  const orderTypeMap = useMemo(() => {
    const map: Record<string, string> = {};
    (brandTypes || []).forEach((o) => { map[o.brandNumber] = o.productType; });
    return map;
  }, [brandTypes]);

  // Previous day's saved sales — used to calculate Opening Balance Value
  const prevDateStr = useMemo(() => {
    const d = parseDateLocal(selectedDate);
    d.setDate(d.getDate() - 1);
    return formatDateLocal(d);
  }, [selectedDate]);

  const { data: prevDaySales } = useQuery<DailySale[]>({
    queryKey: ["/api/sales/prevday", selectedDate],
    queryFn: async () => {
      const res = await fetch(`/api/sales?date=${prevDateStr}`);
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 60_000, // Previous day data doesn't change during a session
    gcTime: 30_000,
  });

  // Earliest invoice date from orders — used as the calendar floor (oldest selectable date)
  // Equivalent to: SELECT DISTINCT invoice_date FROM orders ORDER BY invoice_date DESC LIMIT 1 (text sort)
  const { data: floorDateData } = useQuery<{ invoiceDate: string | null }>({
    queryKey: ["/api/orders/earliest-invoice-date"],
    retry: 2,
    staleTime: 300_000,
  });
  const floorDateStr = floorDateData?.invoiceDate ?? "2020-01-01";
  const floorDate = parse(floorDateStr, "yyyy-MM-dd", new Date());

  // Latest invoice date from orders — used as fallback when no saved sales exist yet
  const { data: latestInvoiceDateData } = useQuery<{ invoiceDate: string | null }>({
    queryKey: ["/api/orders/latest-invoice-date"],
    retry: 2,
    staleTime: 300_000,
  });

  // All dates that have actual sales data — used to grey-out empty dates in the calendar
  const { data: availableSalesDatesData } = useQuery<{ dates: string[] }>({
    queryKey: ["/api/sales/available-dates"],
  });
  const availableSalesDateSet = useMemo(
    () => new Set(availableSalesDatesData?.dates ?? []),
    [availableSalesDatesData],
  );

  // On first load: jump to the most relevant date
  //   1. If saved sales exist and today has none → jump to the most recent saved date
  //   2. If no saved sales exist at all but orders do → jump to the latest order invoice date
  //      (covers fresh shops where inventory was imported but no sales entered yet)
  const hasAutoSelected = useRef(false);
  useEffect(() => {
    if (!availableSalesDatesData || hasAutoSelected.current) return;
    const today = getTodayLocal();
    const dates = availableSalesDatesData.dates;
    if (dates.length > 0 && !dates.includes(today)) {
      hasAutoSelected.current = true;
      setSelectedDate(dates[dates.length - 1]);
    } else if (dates.length === 0 && latestInvoiceDateData?.invoiceDate) {
      hasAutoSelected.current = true;
      setSelectedDate(latestInvoiceDateData.invoiceDate);
    }
  }, [availableSalesDatesData, latestInvoiceDateData]);

  // Compute summary client-side from localSales so it updates in real-time
  const summary = useMemo<SalesSummary>(() => {
    // Opening Balance Value = sum of D-1's (finalClosingBalance bottles × MRP)
    // finalClosingBalance is in bottles; multiplying by MRP gives the stock value
    const openingBalanceValue = (prevDaySales || []).reduce(
      (acc, s) => {
        const bottles = (s.finalClosingBalance as number) || 0;
        const mrp = parseFloat(s.mrp as string) || 0;
        return acc + bottles * mrp;
      },
      0
    );

    // Opening Stock in bottles per type = previous day's totalClosingStock per type
    const categories: Record<string, { opening: number; newStock: number; sold: number; closing: number }> = {};
    for (const s of (prevDaySales || [])) {
      const pType = orderTypeMap[s.brandNumber] || "Other";
      if (!categories[pType]) {
        categories[pType] = { opening: 0, newStock: 0, sold: 0, closing: 0 };
      }
      categories[pType].opening += (s.totalClosingStock || 0);
    }

    let newStockValue = 0;
    let soldStockValue = 0;

    for (const s of localSales) {
      const mrp = parseFloat(s.mrp as string) || 0;
      const qtyPerCase = s.quantityPerCase || 0;
      const newCs = s.newStockCases || 0;
      const newBtls = s.newStockBottles || 0;
      const soldBtls = s.soldBottles || 0;

      // New Stock bottles = (New Stk Cs × Qty/Cs) + New Stk Btls
      const newStockBottlesCalc = (newCs * qtyPerCase) + newBtls;

      newStockValue += newStockBottlesCalc * mrp;
      soldStockValue += soldBtls * mrp;

      const pType = orderTypeMap[s.brandNumber] || "Other";
      if (!categories[pType]) {
        categories[pType] = { opening: 0, newStock: 0, sold: 0, closing: 0 };
      }
      categories[pType].newStock += newStockBottlesCalc;
      categories[pType].sold += soldBtls;
    }

    // Closing Stock per type = Opening + New Stock - Sold (formula-based)
    for (const pType of Object.keys(categories)) {
      categories[pType].closing = categories[pType].opening + categories[pType].newStock - categories[pType].sold;
    }

    const closingBalanceValue = openingBalanceValue + newStockValue - soldStockValue;
    return { openingBalanceValue, newStockValue, soldStockValue, closingBalanceValue, categories };
  }, [localSales, prevDaySales, orderTypeMap]);

  const [searchTerm, setSearchTerm] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [salesSortField, setSalesSortField] = useState<'brandNumber' | 'size' | 'mrp' | 'soldBottles' | null>(null);
  const [salesSortDir, setSalesSortDir] = useState<'asc' | 'desc'>('asc');

  // Bulk Excel upload state
  const excelFileInputRef = useRef<HTMLInputElement>(null);
  const [uploadResult, setUploadResult] = useState<{ updated: number; skipped: number; notFound: number } | null>(null);

  // Refs for the 4 auto-width sticky column headers — used to measure their
  // rendered width so we can set the correct `left` offset on each sticky cell.
  const thSnoRef      = useRef<HTMLTableCellElement>(null);
  const thBrandNoRef  = useRef<HTMLTableCellElement>(null);
  const thBrandNameRef = useRef<HTMLTableCellElement>(null);
  const thSizeRef     = useRef<HTMLTableCellElement>(null);
  const [colLeft, setColLeft] = useState({ sno: 0, brandNo: 0, brandName: 0, size: 0 });

  useEffect(() => {
    const measure = () => {
      if (!thSnoRef.current || !thBrandNoRef.current || !thBrandNameRef.current) return;
      const w0 = thSnoRef.current.offsetWidth;
      const w1 = thBrandNoRef.current.offsetWidth;
      const w2 = thBrandNameRef.current.offsetWidth;
      setColLeft({ sno: 0, brandNo: w0, brandName: w0 + w1, size: w0 + w1 + w2 });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localSales, currentPage, pageSize, searchTerm]);

  // Tracks which item IDs the user has explicitly typed into a closing field this session.
  // Not touched = no sales (closing stays as total stock).
  // Touched with 0 = all sold. Touched with >0 = partial sale.
  const [touchedClosingIds, setTouchedClosingIds] = useState<Set<number>>(new Set());

  // Edit / Delete row state
  const [editingRowId, setEditingRowId] = useState<number | null>(null);
  const [editRowData, setEditRowData] = useState<Partial<DailySale>>({});
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  // Rows pending deletion — applied when Save Sales is clicked (not immediately)
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<number>>(new Set());

  // Quote a CSV cell. Always wraps strings in double quotes and escapes
  // embedded double quotes per RFC 4180 (`"` -> `""`). Numbers/null/undefined
  // are rendered as bare values (empty string for null/undefined).
  const csvCell = useCallback((value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
    const s = String(value);
    return `"${s.replace(/"/g, '""')}"`;
  }, []);

  // Build CSV content for a single date's rows. When `includeDateColumn` is
  // true, prepends a "Date" column so multi-day exports stay distinguishable.
  const buildCsvRowsForDate = useCallback(
    (data: DailySale[], date: string, startSno: number, includeDateColumn: boolean) => {
      return data.map((item, idx) => {
        const totalStock = (item.openingBalanceBottles || 0) + ((item.quantityPerCase || 0) * (item.newStockCases || 0)) + (item.newStockBottles || 0);
        const cells: unknown[] = [
          startSno + idx,
          ...(includeDateColumn ? [date] : []),
          item.brandNumber,
          item.brandName,
          item.size,
          item.quantityPerCase,
          item.openingBalanceBottles,
          item.newStockCases,
          item.newStockBottles,
          totalStock,
          item.closingBalanceCases,
          item.closingBalanceBottles,
          item.soldBottles,
          item.mrp,
          item.saleValue,
          item.breakageBottles,
          item.totalClosingStock,
          item.finalClosingBalance,
        ];
        return cells.map(csvCell).join(",");
      });
    },
    [csvCell],
  );

  const downloadCsv = useCallback((csvContent: string, filename: string) => {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, []);

  // Inclusive list of YYYY-MM-DD strings between two dates (chronological).
  const enumerateDateRange = useCallback((fromYmd: string, toYmd: string): string[] => {
    const start = parse(fromYmd, "yyyy-MM-dd", new Date());
    const end = parse(toYmd, "yyyy-MM-dd", new Date());
    const out: string[] = [];
    const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    while (cur <= end) {
      const y = cur.getFullYear();
      const m = String(cur.getMonth() + 1).padStart(2, "0");
      const d = String(cur.getDate()).padStart(2, "0");
      out.push(`${y}-${m}-${d}`);
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }, []);

  const handleExportCSV = useCallback(async () => {
    if (exportFromDate > exportToDate) {
      toast({
        title: "Invalid Date Range",
        description: "The 'From' date must be on or before the 'To' date.",
        variant: "destructive",
      });
      return;
    }

    const dates = enumerateDateRange(exportFromDate, exportToDate);
    const isRange = dates.length > 1;

    setIsExporting(true);
    try {
      // Fetch all dates. For the date that matches the currently loaded
      // sales, reuse localSales (avoids one network call and keeps any
      // in-progress edits in the export).
      const perDateRows: Array<{ date: string; rows: DailySale[] }> = [];
      for (const d of dates) {
        if (d === selectedDate && localSales) {
          perDateRows.push({ date: d, rows: localSales });
          continue;
        }
        const res = await fetch(`/api/sales?date=${encodeURIComponent(d)}`);
        if (!res.ok) {
          throw new Error(`Failed to fetch ${d} (${res.status})`);
        }
        const rows: DailySale[] = await res.json();
        perDateRows.push({ date: d, rows: rows || [] });
      }

      const totalCount = perDateRows.reduce((sum, p) => sum + p.rows.length, 0);
      if (totalCount === 0) {
        toast({
          title: "No Data",
          description: isRange
            ? `No sales data found between ${exportFromDate} and ${exportToDate}.`
            : `No sales data found for ${exportFromDate}.`,
          variant: "destructive",
        });
        return;
      }

      const headers = [
        "SNo",
        ...(isRange ? ["Date"] : []),
        "Brand No", "Brand Name", "Size", "Qty/Case",
        "Opening Bal (Btls)", "New Stock (Cs)", "New Stock (Btls)",
        "Total Stock", "Closing Bal (Cs)", "Closing Bal (Btls)",
        "Sold Bottles", "MRP", "Sale Value", "Breakage",
        "Total Closing Stock", "Final Closing Bal",
      ];

      const lines: string[] = [headers.map(csvCell).join(",")];
      let sno = 1;
      for (const { date, rows } of perDateRows) {
        if (rows.length === 0) continue;
        const dateRows = buildCsvRowsForDate(rows, date, sno, isRange);
        lines.push(...dateRows);
        sno += rows.length;
      }

      const filename = isRange
        ? `sales_report_${exportFromDate}_to_${exportToDate}.csv`
        : `sales_report_${exportFromDate}.csv`;
      downloadCsv(lines.join("\n"), filename);

      toast({
        title: "Export Successful",
        description: isRange
          ? `Sales data from ${exportFromDate} to ${exportToDate} (${totalCount} rows) exported.`
          : `Sales data for ${exportFromDate} (${totalCount} rows) exported.`,
      });
      setExportDialogOpen(false);
    } catch (error) {
      toast({
        title: "Export Failed",
        description: error instanceof Error ? error.message : "There was an error exporting the data.",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  }, [
    exportFromDate,
    exportToDate,
    enumerateDateRange,
    selectedDate,
    localSales,
    toast,
    buildCsvRowsForDate,
    downloadCsv,
    csvCell,
  ]);

  // Download Excel template pre-populated with current sales data
  const handleDownloadTemplate = useCallback(() => {
    if (!localSales || localSales.length === 0) {
      toast({ title: "No Data", description: "No sales data available for the selected date.", variant: "destructive" });
      return;
    }
    const wsData = [
      ["Brand No", "Brand Name", "Size", "Qty/Case", "Opening Bal (Btls)", "New Stock (Cs)", "New Stock (Btls)", "Total Stock", "Cls Bal (Cs)", "Cls Bal (Btls)", "Breakage"],
      ...localSales.map(s => {
        const qtyPerCase = s.quantityPerCase || 0;
        const opBal = s.openingBalanceBottles || 0;
        const newCs = s.newStockCases || 0;
        const newBtls = s.newStockBottles || 0;
        const totalStock = opBal + (qtyPerCase * newCs) + newBtls;
        return [
          s.brandNumber,
          s.brandName,
          s.size,
          qtyPerCase,
          opBal,
          newCs,
          newBtls,
          totalStock,
          s.closingBalanceCases ?? 0,
          s.closingBalanceBottles ?? 0,
          s.breakageBottles ?? "",
        ];
      }),
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws["!cols"] = [
      { wch: 12 }, { wch: 40 }, { wch: 12 },
      { wch: 10 }, { wch: 20 }, { wch: 16 }, { wch: 18 }, { wch: 14 },
      { wch: 14 }, { wch: 16 }, { wch: 12 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sales Template");
    XLSX.writeFile(wb, `sales_template_${selectedDate}.xlsx`);
  }, [localSales, selectedDate, toast]);

  // Upload Excel and apply values into localSales (same calculation as handleInputChange)
  const handleUploadExcel = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate that the uploaded file matches the currently selected date
    if (!file.name.includes(selectedDate)) {
      toast({
        title: "Wrong Template File",
        description: `This file doesn't match the selected date (${selectedDate}). Please download the template for the correct date and upload that file.`,
        variant: "destructive",
        duration: 6000,
      });
      if (excelFileInputRef.current) excelFileInputRef.current.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const wb = XLSX.read(evt.target?.result, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1 });
        if (rows.length < 2) {
          toast({ title: "Invalid File", description: "The file has no data rows.", variant: "destructive" });
          return;
        }
        const header = (rows[0] as string[]).map(h => String(h || "").trim().toLowerCase());
        const col = {
          brandNo:  header.findIndex(h => h.includes("brand no")),
          size:     header.findIndex(h => h.includes("size")),
          clsCs:    header.findIndex(h => h.includes("cls bal (cs)")),
          clsBtls:  header.findIndex(h => h.includes("cls bal (btls)")),
          breakage: header.findIndex(h => h.includes("breakage")),
        };
        if (col.brandNo === -1 || col.size === -1) {
          toast({ title: "Invalid Template", description: "Could not find Brand No or Size columns. Please use the downloaded template.", variant: "destructive" });
          return;
        }

        let updated = 0, skipped = 0, notFound = 0;
        const uploadedTouchedIds: number[] = [];

        setLocalSales(prev => {
          const next = [...prev];
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i] as any[];
            if (!row || row.length === 0) continue;
            const brandNo = String(row[col.brandNo] ?? "").trim();
            const size = String(row[col.size] ?? "").trim();
            if (!brandNo || !size) { skipped++; continue; }

            const clsCsRaw   = col.clsCs   >= 0 ? row[col.clsCs]   : undefined;
            const clsBtlsRaw = col.clsBtls >= 0 ? row[col.clsBtls] : undefined;
            const brkRaw     = col.breakage >= 0 ? row[col.breakage] : undefined;

            const clsEmpty  = clsCsRaw  === undefined || clsCsRaw  === null || clsCsRaw  === "";
            const btlsEmpty = clsBtlsRaw === undefined || clsBtlsRaw === null || clsBtlsRaw === "";

            // Both empty → no sale → skip (closing stays as opening)
            if (clsEmpty && btlsEmpty) { skipped++; continue; }

            const clsCs   = clsEmpty  ? 0 : (parseInt(String(clsCsRaw),   10) || 0);
            const clsBtls = btlsEmpty ? 0 : (parseInt(String(clsBtlsRaw), 10) || 0);
            const breakage = (brkRaw === undefined || brkRaw === null || brkRaw === "") ? 0 : (parseInt(String(brkRaw), 10) || 0);

            const idx = next.findIndex(s => s.brandNumber === brandNo && s.size === size);
            if (idx === -1) { notFound++; continue; }

            // Apply identical calculation to handleInputChange
            const item = next[idx];
            const opBalBtls  = item.openingBalanceBottles || 0;
            const qtyPerCase = item.quantityPerCase || 0;
            const newStockCs = item.newStockCases || 0;
            const newStockBtls = item.newStockBottles || 0;
            const mrp = parseFloat(item.mrp as string) || 0;

            const totalStock      = opBalBtls + (qtyPerCase * newStockCs) + newStockBtls;
            const closingTotal    = clsBtls + (clsCs * qtyPerCase);
            const soldBottles     = totalStock - closingTotal;
            const saleValue       = soldBottles * mrp;

            next[idx] = {
              ...item,
              closingBalanceCases: clsCs,
              closingBalanceBottles: clsBtls,
              breakageBottles: breakage,
              soldBottles,
              saleValue: saleValue.toFixed(2),
              totalSaleValue: saleValue.toFixed(2),
              totalClosingStock: closingTotal,
              finalClosingBalance: Math.round(closingTotal - breakage),
            };
            // Only mark as touched when actual sales or breakage occurred;
            // rows where closing equals total stock (no change) stay untouched so DB stays clean
            if (soldBottles !== 0 || breakage > 0) {
              uploadedTouchedIds.push(item.id);
            }
            updated++;
          }
          setUploadResult({ updated, skipped, notFound });
          return next;
        });

        // Mark Excel-uploaded items as touched so they display their closing values
        if (uploadedTouchedIds.length > 0) {
          setTouchedClosingIds(prev => new Set([...Array.from(prev), ...uploadedTouchedIds]));
        }

        if (excelFileInputRef.current) excelFileInputRef.current.value = "";
        toast({
          title: "Upload Complete",
          description: `${updated} row(s) updated · ${skipped} skipped (blank) · ${notFound} not matched`,
          className: updated > 0 ? "bg-green-50 border-green-200 text-green-800" : undefined,
        });
      } catch {
        toast({ title: "Upload Failed", description: "Could not read the file. Please use the downloaded template.", variant: "destructive" });
      }
    };
    reader.readAsBinaryString(file);
  }, [toast, selectedDate]);

  // Sync local state when data loads or date changes
  useEffect(() => {
    if (sales) {
      // Determine which rows were previously saved with explicit closing data
      const newTouched = new Set<number>();
      for (const s of sales) {
        // Row was explicitly saved if: closing > 0 (partial sale) OR soldBottles > 0 (all sold)
        if ((s.closingBalanceCases || 0) > 0 || (s.closingBalanceBottles || 0) > 0 || (s.soldBottles || 0) > 0) {
          newTouched.add(s.id);
        }
      }
      setTouchedClosingIds(newTouched);

      const recalculated = sales.map((s) => {
        const opBalBtls    = s.openingBalanceBottles ?? 0;
        const qtyPerCase   = s.quantityPerCase ?? 0;
        const newStockCs   = s.newStockCases ?? 0;
        const newStockBtls = s.newStockBottles ?? 0;
        const closingCs    = s.closingBalanceCases ?? 0;
        const closingBtls  = s.closingBalanceBottles ?? 0;
        const breakage     = s.breakageBottles ?? 0;
        const mrp          = parseFloat(s.mrp as string) || 0;
        const totalStock   = opBalBtls + (qtyPerCase * newStockCs) + newStockBtls;

        // Rows not previously touched: no sales — pre-fill closing with actual stock
        const isTouched = newTouched.has(s.id);
        if (!isTouched) {
          const defaultCs   = qtyPerCase > 0 ? Math.floor(totalStock / qtyPerCase) : 0;
          const defaultBtls = qtyPerCase > 0 ? totalStock % qtyPerCase : totalStock;
          return {
            ...s,
            closingBalanceCases: defaultCs,
            closingBalanceBottles: defaultBtls,
            soldBottles: 0,
            saleValue: "0.00",
            totalSaleValue: "0.00",
            totalClosingStock: totalStock,
            finalClosingBalance: Math.round(totalStock - breakage),
          };
        }

        // Rows with explicit closing data: recalculate fully
        const closingTotal = closingBtls + (closingCs * qtyPerCase);
        const soldBottles  = totalStock - closingTotal;
        const saleValue    = soldBottles * mrp;

        return {
          ...s,
          soldBottles,
          saleValue: saleValue.toFixed(2),
          totalSaleValue: saleValue.toFixed(2),
          totalClosingStock: closingTotal,
          finalClosingBalance: Math.round(closingTotal - breakage),
        };
      });
      setLocalSales(recalculated);
    }
  }, [sales]);

  // Reset page on date change
  useEffect(() => {
    setCurrentPage(1);
    setSearchTerm("");
    setUploadResult(null);
    setTouchedClosingIds(new Set());
    setPendingDeleteIds(new Set());
    setEditingRowId(null);
    setEditRowData({});
    setDeleteConfirmId(null);
  }, [selectedDate]);

  const handleInputChange = (
    id: number,
    field: keyof DailySale,
    value: string,
  ) => {
    if (isSubmitted && !isAdmin) return;

    const isClosingField = field === "closingBalanceCases" || field === "closingBalanceBottles";

    // Mark as touched when user explicitly types into a closing field
    if (isClosingField) {
      setTouchedClosingIds((prev) => new Set([...Array.from(prev), id]));
    }

    const numValue =
      field === "mrp" ? value : value === "" ? 0 : parseInt(value, 10);

    setLocalSales((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;

        const updatedItem = { ...item, [field]: numValue };

        const opBalBtls  = updatedItem.openingBalanceBottles || 0;
        const qtyPerCase = updatedItem.quantityPerCase || 0;
        const newStockCs = updatedItem.newStockCases || 0;
        const newStockBtls = updatedItem.newStockBottles || 0;
        const closingCs  = updatedItem.closingBalanceCases || 0;
        const closingBtls = updatedItem.closingBalanceBottles || 0;
        const mrp        = parseFloat(updatedItem.mrp as string) || 0;
        const breakage   = updatedItem.breakageBottles || 0;
        const totalStock = opBalBtls + (qtyPerCase * newStockCs) + newStockBtls;

        // "Touched" means the user has explicitly typed into a closing field for this item.
        // touchedClosingIds state is stale here but isClosingField covers the current call.
        const isTouched = isClosingField || touchedClosingIds.has(id);

        if (!isTouched) {
          // Non-closing field changed, item never touched → keep "no sales" mode
          return {
            ...updatedItem,
            soldBottles: 0,
            saleValue: "0.00",
            totalSaleValue: "0.00",
            totalClosingStock: totalStock,
            finalClosingBalance: Math.round(totalStock - breakage),
          };
        }

        // Item is touched: use actual closing values (0 = all sold, >0 = partial)
        const closingTotal = closingBtls + (closingCs * qtyPerCase);
        const soldBottles  = totalStock - closingTotal;
        const saleValue    = soldBottles * mrp;

        return {
          ...updatedItem,
          soldBottles,
          saleValue: saleValue.toFixed(2),
          totalSaleValue: saleValue.toFixed(2),
          totalClosingStock: closingTotal,
          finalClosingBalance: Math.round(closingTotal - breakage),
        };
      }),
    );
  };

  const handleSave = () => {
    if (isSubmitted && !isAdmin) return;
    const negativeItems = localSales.filter((item) => (item.soldBottles || 0) < 0);
    if (negativeItems.length > 0) {
      const names = negativeItems.map((item) => `${item.brandName} (${item.size})`).join(", ");
      toast({
        title: "Warning: Negative Sold Bottles",
        description: `The following items have negative sold bottles: ${names}. Please check closing balance values before saving.`,
        variant: "destructive",
        duration: 8000,
      });
      return;
    }

    // Untouched items → no sales: send 0s to server so DB stays clean
    const serverData = localSales.map((item) => {
      if (!touchedClosingIds.has(item.id)) {
        const totalStk =
          (item.openingBalanceBottles || 0) +
          (item.quantityPerCase || 0) * (item.newStockCases || 0) +
          (item.newStockBottles || 0);
        return {
          ...item,
          closingBalanceCases: 0,
          closingBalanceBottles: 0,
          soldBottles: 0,
          saleValue: "0.00",
          totalSaleValue: "0.00",
          totalClosingStock: totalStk,
          finalClosingBalance: Math.round(totalStk - (item.breakageBottles || 0)),
        };
      }
      return item;
    });

    // Only update touched rows in the UI — keep pre-filled defaults for untouched rows (no flash)
    setLocalSales(prev => prev.map(item => {
      if (!touchedClosingIds.has(item.id)) return item;
      return serverData.find(s => s.id === item.id) ?? item;
    }));

    const deleteIdsArray = Array.from(pendingDeleteIds);
    updateSales({ data: serverData, date: selectedDate, deleteIds: deleteIdsArray }, {
      onSuccess: () => {
        setPendingDeleteIds(new Set());
      },
      onError: (err) => {
        toast({
          title: "Error",
          description: err.message,
          variant: "destructive",
        });
      },
    });
  };

  const handleSubmit = () => {
    if (isSubmitted && !isAdmin) return;
    if (!localSales || localSales.length === 0) {
      toast({
        title: "No Data",
        description: "There is no sales data to submit for this date.",
        variant: "destructive",
      });
      return;
    }

    submitSales(selectedDate, {
      onSuccess: () => {
      },
      onError: (err) => {
        toast({
          title: "Submit Failed",
          description: err.message,
          variant: "destructive",
        });
      },
    });
  };

  // --- Edit row handlers ---
  const handleEditStart = (item: DailySale) => {
    setEditingRowId(item.id);
    setEditRowData({ ...item });
    setDeleteConfirmId(null);
  };

  const handleEditFieldChange = (field: keyof DailySale, value: string) => {
    setEditRowData((prev) => ({ ...prev, [field]: value === "" ? 0 : Number(value) }));
  };

  const handleEditConfirm = () => {
    if (editingRowId === null) return;
    const d = editRowData;
    const qtyPerCase = Number(d.quantityPerCase ?? 0);
    const opBal = Number(d.openingBalanceBottles ?? 0);
    const newCs = Number(d.newStockCases ?? 0);
    const newBtls = Number(d.newStockBottles ?? 0);
    const clsCs = Number(d.closingBalanceCases ?? 0);
    const clsBtls = Number(d.closingBalanceBottles ?? 0);
    const breakage = Number(d.breakageBottles ?? 0);
    const mrp = Number(d.mrp ?? 0);

    const totalStock = opBal + (qtyPerCase * newCs) + newBtls;
    const closingTotal = clsBtls + (clsCs * qtyPerCase);
    const soldBottles = totalStock - closingTotal;
    const saleValue = (soldBottles * mrp).toFixed(2);
    const totalClosingStock = closingTotal;
    const finalClosingBalance = Math.round(totalClosingStock - breakage);

    setLocalSales((prev) =>
      prev.map((row) =>
        row.id === editingRowId
          ? {
              ...row,
              openingBalanceBottles: opBal,
              newStockCases: newCs,
              newStockBottles: newBtls,
              closingBalanceCases: clsCs,
              closingBalanceBottles: clsBtls,
              breakageBottles: breakage,
              soldBottles,
              saleValue,
              totalClosingStock,
              finalClosingBalance,
            }
          : row,
      ),
    );
    // Mark as touched so Save Sales uses the edited values
    setTouchedClosingIds((prev) => new Set(prev).add(editingRowId));
    setEditingRowId(null);
    setEditRowData({});
  };

  const handleEditCancel = () => {
    setEditingRowId(null);
    setEditRowData({});
  };

  // --- Delete row handlers ---
  // Deletion is deferred to Save Sales — we just hide the row locally and track IDs
  const handleDeleteConfirm = (id: number) => {
    setPendingDeleteIds((prev) => new Set(prev).add(id));
    setLocalSales((prev) => prev.filter((row) => row.id !== id));
    setTouchedClosingIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
    setDeleteConfirmId(null);
    toast({
      title: "Row Removed",
      description: "Row marked for deletion. Click 'Save Sales' to apply all changes to the database.",
      className: "bg-amber-50 border-amber-200 text-amber-800",
      duration: 5000,
    });
  };

  const handleSalesSortToggle = (field: 'brandNumber' | 'size' | 'mrp' | 'soldBottles') => {
    if (salesSortField === field) {
      setSalesSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSalesSortField(field);
      setSalesSortDir('asc');
    }
    setCurrentPage(1);
  };

  const speech = useSpeechSales({
    onUpdateRow: (match, fields) => {
      if (isSubmitted && !isAdmin) return;
      if (!isDateAllowedForAction) {
        toast({ title: "Date Restricted", description: "Cannot update sales for this date.", variant: "destructive" });
        return;
      }
      const row = localSales.find((item) => {
        if (match.brandNumber && item.brandNumber.trim() !== match.brandNumber.trim()) return false;
        if (match.size) {
          const normalizedItemSize = item.size.replace(/\s/g, "").toLowerCase();
          const normalizedMatchSize = match.size.replace(/\s/g, "").toLowerCase();
          if (normalizedItemSize !== normalizedMatchSize) return false;
        }
        if (match.brandName) {
          const nameLower = item.brandName.toLowerCase();
          const searchLower = match.brandName.toLowerCase();
          if (!nameLower.includes(searchLower)) return false;
        }
        return true;
      });
      if (!row) {
        toast({
          title: "No Match Found",
          description: `Could not find a row matching: ${[match.brandNumber, match.brandName, match.size].filter(Boolean).join(", ")}`,
          variant: "destructive",
          duration: 5000,
        });
        return;
      }
      if (fields.closingCases !== undefined) {
        handleInputChange(row.id, "closingBalanceCases", String(fields.closingCases));
      }
      if (fields.closingBottles !== undefined) {
        handleInputChange(row.id, "closingBalanceBottles", String(fields.closingBottles));
      }
      if (fields.breakage !== undefined) {
        handleInputChange(row.id, "breakageBottles", String(fields.breakage));
      }
      toast({
        title: "Voice Updated",
        description: `Updated ${row.brandName} (${row.size}): ${[
          fields.closingCases !== undefined ? `Cases: ${fields.closingCases}` : "",
          fields.closingBottles !== undefined ? `Bottles: ${fields.closingBottles}` : "",
          fields.breakage !== undefined ? `Breakage: ${fields.breakage}` : "",
        ].filter(Boolean).join(", ")}`,
        duration: 4000,
      });
    },
    onSave: () => {
      if (isSubmitted && !isAdmin) return;
      if (!isDateAllowedForAction) return;
      handleSave();
    },
    onSubmit: () => {
      if (isSubmitted && !isAdmin) return;
      if (!isDateAllowedForAction) return;
      handleSave();
      setTimeout(() => handleSubmit(), 600);
    },
    onSelectDate: (dateStr: string) => setSelectedDate(dateStr),
    onPageChange: (direction) => {
      setCurrentPage((prev) => {
        if (direction === "next") return Math.min(prev + 1, totalPages);
        if (direction === "prev") return Math.max(prev - 1, 1);
        if (direction === "first") return 1;
        if (direction === "last") return totalPages;
        if (typeof direction === "number") return Math.min(Math.max(direction, 1), totalPages);
        return prev;
      });
    },
  });

  const filteredSales = useMemo(() => {
    const q = searchTerm.toLowerCase();
    let rows = localSales.filter(
      (item) =>
        (item.brandName ?? "").toLowerCase().includes(q) ||
        (item.brandNumber ?? "").toLowerCase().includes(q),
    );
    if (salesSortField) {
      rows = [...rows].sort((a, b) => {
        let av: number | string = 0, bv: number | string = 0;
        if (salesSortField === 'brandNumber') { av = a.brandNumber; bv = b.brandNumber; }
        else if (salesSortField === 'size') { av = parseFloat(a.size) || 0; bv = parseFloat(b.size) || 0; }
        else if (salesSortField === 'mrp') { av = parseFloat(a.mrp as string) || 0; bv = parseFloat(b.mrp as string) || 0; }
        else if (salesSortField === 'soldBottles') { av = a.soldBottles ?? 0; bv = b.soldBottles ?? 0; }
        if (av < bv) return salesSortDir === 'asc' ? -1 : 1;
        if (av > bv) return salesSortDir === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return rows;
  }, [localSales, searchTerm, salesSortField, salesSortDir]);

  const totalPages = Math.ceil(filteredSales.length / pageSize);
  const paginatedSales = filteredSales.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const formatCurrency = (val: number) => {
    return `₹${val.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const shopName = shopDetails?.[0]?.shopName || "Shop Name";

  const cats = summary?.categories || {};
  const imlCount = (field: keyof typeof cats[string]) =>
    (cats["IML"]?.[field] || 0) + (cats["IMFL"]?.[field] || 0);
  const beerCount = (field: keyof typeof cats[string]) =>
    cats["Beer"]?.[field] || 0;

  if (isLoading) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-500">
      {/* Shop Name & Date Picker */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3" data-testid="text-shop-name">
          <Store className="w-5 h-5 text-muted-foreground" />
          <h2 className="text-xl font-semibold text-foreground">{shopName}</h2>
        </div>
        <div className="flex items-center gap-1">
          {/* Previous Day Button */}
          <button
            data-testid="button-prev-date"
            onClick={() => {
              const d = parseDateLocal(selectedDate);
              d.setDate(d.getDate() - 1);
              const prev = formatDateLocal(d);
              if (prev >= floorDateStr) setSelectedDate(prev);
            }}
            disabled={selectedDate <= floorDateStr}
            className="p-2 rounded-lg border border-border bg-card hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Previous day"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
            <PopoverTrigger asChild>
              <button
                data-testid="input-date-picker"
                className="flex items-center gap-2 bg-card border border-border rounded-xl px-3 py-2 shadow-sm cursor-pointer hover:bg-accent transition-colors"
              >
                <CalendarIcon className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-medium text-muted-foreground whitespace-nowrap">Select Date:</span>
                <span className="text-sm font-semibold text-foreground">
                  {format(parse(selectedDate, "yyyy-MM-dd", new Date()), "dd-MM-yyyy")}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="single"
                selected={parse(selectedDate, "yyyy-MM-dd", new Date())}
                defaultMonth={parse(selectedDate, "yyyy-MM-dd", new Date())}
                onSelect={(date) => {
                  if (date) {
                    const y = date.getFullYear();
                    const m = String(date.getMonth() + 1).padStart(2, "0");
                    const d = String(date.getDate()).padStart(2, "0");
                    setSelectedDate(`${y}-${m}-${d}`);
                    setDatePickerOpen(false);
                  }
                }}
                fromDate={floorDate}
                toDate={new Date()}
                disabled={(date) => {
                  const dateStr = format(date, "yyyy-MM-dd");
                  const todayStr = format(new Date(), "yyyy-MM-dd");
                  if (dateStr > todayStr) return true;
                  if (dateStr < floorDateStr) return true;
                  if (!isAdmin) {
                    const sevenDaysAgo = subDays(new Date(), 6);
                    sevenDaysAgo.setHours(0, 0, 0, 0);
                    if (date < sevenDaysAgo) return true;
                  }
                  return false;
                }}
                initialFocus
              />
            </PopoverContent>
          </Popover>

          {/* Next Day Button */}
          <button
            data-testid="button-next-date"
            onClick={() => {
              const d = parseDateLocal(selectedDate);
              d.setDate(d.getDate() + 1);
              const next = formatDateLocal(d);
              const today = getTodayLocal();
              if (next <= today) setSelectedDate(next);
            }}
            disabled={selectedDate >= getTodayLocal()}
            className="p-2 rounded-lg border border-border bg-card hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Next day"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          {isSubmitted && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-700 text-sm font-medium dark:bg-emerald-900/20 dark:border-emerald-700 dark:text-emerald-400" data-testid="status-submitted">
              <Lock className="w-4 h-4" />
              Submitted & Locked
            </div>
          )}
        </div>
      </div>

      {/* Combined summary cards — value + bottles in one row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Opening */}
        <div className="bg-card rounded-xl border border-border shadow-sm flex overflow-hidden" data-testid="card-opening-balance-value">
          <div className="flex-1 p-3 min-w-0">
            <p className="text-xs font-medium text-muted-foreground mb-1 truncate">Opening Balance Value</p>
            <p className="text-lg font-bold text-foreground">{formatCurrency(summary?.openingBalanceValue || 0)}</p>
          </div>
          <div className="w-px bg-border self-stretch" />
          <div className="flex-1 p-3 min-w-0" data-testid="card-opening-stock">
            <p className="text-xs font-medium text-muted-foreground mb-1 truncate">opening Stock in bottles</p>
            <div className="space-y-0.5 text-sm font-semibold text-foreground">
              <p>IML - {imlCount("opening").toLocaleString()}</p>
              <p>Beer - {beerCount("opening").toLocaleString()}</p>
            </div>
          </div>
        </div>

        {/* New Stock */}
        <div className="bg-card rounded-xl border border-border shadow-sm flex overflow-hidden" data-testid="card-new-stock-value">
          <div className="flex-1 p-3 min-w-0">
            <p className="text-xs font-medium text-muted-foreground mb-1 truncate">New Stock Value</p>
            <p className="text-lg font-bold text-foreground">{formatCurrency(summary?.newStockValue || 0)}</p>
          </div>
          <div className="w-px bg-border self-stretch" />
          <div className="flex-1 p-3 min-w-0" data-testid="card-new-stock">
            <p className="text-xs font-medium text-muted-foreground mb-1 truncate">New Stock in bottles</p>
            <div className="space-y-0.5 text-sm font-semibold text-foreground">
              <p>IML - {imlCount("newStock")}</p>
              <p>Beer - {beerCount("newStock")}</p>
            </div>
          </div>
        </div>

        {/* Sold Stock */}
        <div className="bg-card rounded-xl border border-border shadow-sm flex overflow-hidden" data-testid="card-sold-stock-value">
          <div className="flex-1 p-3 min-w-0">
            <p className="text-xs font-medium text-muted-foreground mb-1 truncate">Sold Stock Value</p>
            <p className="text-lg font-bold text-foreground">{formatCurrency(summary?.soldStockValue || 0)}</p>
          </div>
          <div className="w-px bg-border self-stretch" />
          <div className="flex-1 p-3 min-w-0" data-testid="card-sold-stock">
            <p className="text-xs font-medium text-muted-foreground mb-1 truncate">Sold Stock in bottles</p>
            <div className="space-y-0.5 text-sm font-semibold text-foreground">
              <p>IML - {imlCount("sold").toLocaleString()}</p>
              <p>Beer - {beerCount("sold").toLocaleString()}</p>
            </div>
          </div>
        </div>

        {/* Closing */}
        <div className="bg-card rounded-xl border border-border shadow-sm flex overflow-hidden" data-testid="card-closing-balance-value">
          <div className="flex-1 p-3 min-w-0">
            <p className="text-xs font-medium text-muted-foreground mb-1 truncate">Closing Balance Value</p>
            <p className="text-lg font-bold text-foreground">{formatCurrency(summary?.closingBalanceValue || 0)}</p>
          </div>
          <div className="w-px bg-border self-stretch" />
          <div className="flex-1 p-3 min-w-0" data-testid="card-closing-stock">
            <p className="text-xs font-medium text-muted-foreground mb-1 truncate">Closing Stock in bottles</p>
            <div className="space-y-0.5 text-sm font-semibold text-foreground">
              <p>IML - {imlCount("closing")}</p>
              <p>Beer - {beerCount("closing")}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content Card */}
      <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden flex flex-col">

        {/* Toolbar */}
        <div className="p-4 border-b border-border flex flex-col sm:flex-row gap-4 justify-between items-center bg-card">
          <div className="flex items-center gap-3 w-full sm:w-auto flex-wrap">
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                placeholder="Search by brand name or code..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                data-testid="input-search-sales"
                className="w-full pl-10 pr-4 py-2 rounded-xl border border-input bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
              />
            </div>
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto flex-wrap justify-end">
            <div className="relative group">
              <button
                disabled
                data-testid="button-voice-input-unsupported"
                className="flex items-center gap-2 px-4 py-2 rounded-xl font-medium shadow-sm bg-violet-600/40 text-white/60 cursor-not-allowed"
              >
                <Mic className="w-4 h-4" />
                Voice
              </button>
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-50 pointer-events-none">
                <div className="bg-gray-900 text-white text-xs rounded-lg px-3 py-2 whitespace-nowrap shadow-lg">
                  Voice input is temporarily disabled
                  <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
                </div>
              </div>
            </div>
            {/* Import split-button */}
            <div className="flex items-stretch">
              <button
                onClick={() => { setUploadResult(null); excelFileInputRef.current?.click(); }}
                disabled={!localSales || localSales.length === 0 || (isSubmitted && !isAdmin)}
                data-testid="button-upload-sales-data"
                className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-l-xl font-medium shadow-sm hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed border-r border-primary-foreground/20"
              >
                <Upload className="w-4 h-4" />
                Import
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    disabled={!localSales || localSales.length === 0 || (isSubmitted && !isAdmin)}
                    data-testid="button-import-dropdown"
                    className="flex items-center px-2 py-2 bg-primary text-primary-foreground rounded-r-xl font-medium shadow-sm hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => { setUploadResult(null); excelFileInputRef.current?.click(); }}
                    disabled={!localSales || localSales.length === 0 || (isSubmitted && !isAdmin)}
                    data-testid="menu-import-excel"
                  >
                    <Upload className="w-4 h-4 mr-2" /> Upload Sales Data by Date
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={handleDownloadTemplate}
                    disabled={!localSales || localSales.length === 0}
                    data-testid="menu-download-template"
                  >
                    <FileSpreadsheet className="w-4 h-4 mr-2" /> Download sample template
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <input
              ref={excelFileInputRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={handleUploadExcel}
              data-testid="input-upload-excel"
            />
            {uploadResult && (
              <span className="text-xs font-medium text-muted-foreground bg-card border border-border rounded-lg px-3 py-1.5 flex items-center gap-2">
                <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                <span className="text-green-700 font-semibold">{uploadResult.updated} updated</span>
                {uploadResult.skipped > 0 && <span>· {uploadResult.skipped} skipped</span>}
                {uploadResult.notFound > 0 && <span className="text-amber-600">· {uploadResult.notFound} not matched</span>}
                <span className="text-muted-foreground/60">— review & click Save Sales</span>
              </span>
            )}

            <button
              onClick={() => {
                setExportFromDate(selectedDate);
                setExportToDate(selectedDate);
                setExportDialogOpen(true);
              }}
              disabled={isExporting}
              data-testid="button-export-csv"
              className="flex items-center gap-2 px-6 py-2 bg-secondary text-secondary-foreground rounded-xl font-medium border border-border hover:bg-secondary/80 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isExporting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              Export CSV
            </button>

            {isSubmitted && !isAdmin ? (
              <div className="flex items-center gap-2 px-6 py-2 bg-emerald-100 text-emerald-700 rounded-xl font-medium border border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-700 dark:text-emerald-400" data-testid="status-locked-buttons">
                <Lock className="w-4 h-4" />
                Locked
              </div>
            ) : !isDateAllowedForAction ? (
              <div className="flex items-center gap-2 px-6 py-2 bg-amber-50 text-amber-700 rounded-xl font-medium border border-amber-200 dark:bg-amber-900/20 dark:border-amber-700 dark:text-amber-400" data-testid="status-date-restricted">
                <Lock className="w-4 h-4" />
                Date outside allowed range
              </div>
            ) : (
              <>
                {isAdmin && isSubmitted && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-xl text-amber-700 text-xs font-medium dark:bg-amber-900/20 dark:border-amber-700 dark:text-amber-400" data-testid="status-already-submitted-info">
                    <CheckCircle className="w-3.5 h-3.5" />
                    Sales already submitted
                  </div>
                )}
                <button
                  onClick={handleSave}
                  disabled={isSaving}
                  data-testid="button-save-sales"
                  className="flex items-center gap-2 px-6 py-2 bg-primary text-primary-foreground rounded-xl font-medium shadow-lg shadow-primary/25 hover:bg-primary/90 hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSaving ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                  Save Sales
                </button>

                <button
                  onClick={handleSubmit}
                  disabled={isSubmitting || localSales.length === 0}
                  data-testid="button-submit-sales"
                  className="flex items-center gap-2 px-6 py-2 bg-emerald-600 text-white rounded-xl font-medium shadow-lg hover:bg-emerald-700 hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                  Submit Sales
                </button>
              </>
            )}
          </div>
        </div>

        {/* Table */}
        <div className="overflow-auto max-h-[calc(100dvh-220px)] table-typography rounded-b-lg border border-border">
          <table className="w-full min-w-[1400px] border-separate border-spacing-0">
            <thead className="sticky top-0 z-20 bg-secondary shadow-sm">
              <tr className="bg-secondary border-b-2 border-border">
                <th ref={thSnoRef} className="table-header w-[35px] min-w-[35px] whitespace-nowrap border-r border-border sticky left-0 top-0 z-30 bg-secondary">SNo</th>
                <th ref={thBrandNoRef} className="table-header w-[10px] min-w-[10px] whitespace-nowrap border-r border-border sticky top-0 z-30 bg-secondary" style={{ left: colLeft.brandNo }}>
                  <button onClick={() => handleSalesSortToggle('brandNumber')} className="flex items-center gap-1 hover:text-foreground w-full">
                    Brand No {salesSortField === 'brandNumber' ? (salesSortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-40" />}
                  </button>
                </th>
                <th ref={thBrandNameRef} className="table-header w-[170px] min-w-[170px] max-w-[170px] whitespace-nowrap border-r border-border sticky top-0 z-30 bg-secondary shadow-[2px_0_0_0_rgba(0,0,0,0.04)]" style={{ left: colLeft.brandName }}>Brand Name</th>
                <th ref={thSizeRef} className="table-header w-[52px] min-w-[52px] whitespace-nowrap border-r border-border sticky top-0 z-30 bg-secondary shadow-[4px_0_6px_-4px_rgba(0,0,0,0.15)]" style={{ left: colLeft.size }}>
                  <button onClick={() => handleSalesSortToggle('size')} className="flex items-center gap-1 hover:text-foreground w-full">
                    Size {salesSortField === 'size' ? (salesSortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-40" />}
                  </button>
                </th>
                <th className="table-header w-10 border-r border-border">Qty/Cs</th>
                <th className="table-header w-14 border-r border-border">Op. Bal (Btls)</th>
                <th className="table-header w-16 text-right bg-green-50/50 border-r border-border">New Stk (Cs)</th>
                <th className="table-header w-16 text-right bg-green-50/50 border-r border-border">New Stk (Btls)</th>
                <th className="table-header w-14 text-right border-r border-border">Total Stk</th>
                <th className="table-header w-20 text-center bg-orange-50/80 border-l border-orange-100 font-bold text-orange-900 border-r border-border">
                  CB for Cases
                </th>
                <th className="table-header w-20 text-center bg-orange-50/80 font-bold text-orange-900 border-r border-border">
                  CB for Bottles
                </th>
                <th className="table-header w-14 text-center border-r border-border">
                  <button onClick={() => handleSalesSortToggle('soldBottles')} className="flex items-center gap-1 hover:text-foreground mx-auto">
                    Sold Btls {salesSortField === 'soldBottles' ? (salesSortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-40" />}
                  </button>
                </th>
                <th className="table-header w-14 text-center border-r border-border">
                  <button onClick={() => handleSalesSortToggle('mrp')} className="flex items-center gap-1 hover:text-foreground mx-auto">
                    MRP {salesSortField === 'mrp' ? (salesSortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-40" />}
                  </button>
                </th>
                <th className="table-header w-20 text-right font-bold text-primary border-r border-border">Sale Value</th>
                <th className="table-header w-16 text-center border-r border-border">Tot Cls Stk</th>
                <th className="table-header w-14 text-center border-r border-border">Breakage</th>
                <th className="table-header w-20 text-center border-r border-border">Final Cls Stk Bal</th>
              </tr>
            </thead>
            <tbody>
              {paginatedSales.length === 0 ? (
                <tr>
                  <td
                    colSpan={17}
                    className="py-12 text-center text-muted-foreground"
                  >
                    {searchTerm ? `No sales records found matching "${searchTerm}"` : `No sales data for ${selectedDate}`}
                  </td>
                </tr>
              ) : (
                paginatedSales.map((item, idx) => {
                  const globalIdx = (currentPage - 1) * pageSize + idx;
                  const opBal = item.openingBalanceBottles || 0;
                  const newCs = item.newStockCases || 0;
                  const newBtls = item.newStockBottles || 0;
                  const qtyPerCase = item.quantityPerCase || 0;
                  const editMrp = Number(item.mrp || 0);
                  const totalStock = opBal + (qtyPerCase * newCs) + newBtls;
                  const rowBg = idx % 2 === 1 ? "bg-[#fafafa]" : "bg-white";
                  return (
                    <tr
                      key={item.id}
                      className={`transition-colors group ${rowBg} hover:bg-primary/5 ${isSubmitted ? "opacity-90" : ""}`}
                    >
                      <td className={`table-cell w-[35px] min-w-[35px] whitespace-nowrap font-mono text-xs text-muted-foreground border-r border-border sticky left-0 z-10 ${rowBg} group-hover:bg-[#fff5f4]`}>
                        {globalIdx + 1}
                      </td>
                      <td className={`table-cell w-[10px] min-w-[10px] whitespace-nowrap font-mono text-xs text-muted-foreground border-r border-border sticky z-10 ${rowBg} group-hover:bg-[#fff5f4]`} style={{ left: colLeft.brandNo }}>
                        {item.brandNumber}
                      </td>
                      <td className={`table-cell w-[170px] min-w-[170px] max-w-[170px] truncate font-medium border-r border-border sticky z-10 ${rowBg} group-hover:bg-[#fff5f4]`} style={{ left: colLeft.brandName }} title={item.brandName}>{item.brandName}</td>
                      <td className={`table-cell w-[52px] min-w-[52px] whitespace-nowrap text-muted-foreground border-r border-border sticky z-10 ${rowBg} group-hover:bg-[#fff5f4] shadow-[4px_0_6px_-4px_rgba(0,0,0,0.15)]`} style={{ left: colLeft.size }}>
                        {item.size}
                      </td>
                      <td className="table-cell text-muted-foreground border-r border-border">
                        {item.quantityPerCase}
                      </td>
                      {/* Op Bal */}
                      <td className="table-cell p-1 bg-blue-50/10 group-hover:bg-blue-50/30 border-r border-border">
                        <span className="block text-right font-mono text-muted-foreground">{item.openingBalanceBottles}</span>
                      </td>
                      {/* New Stk Cs */}
                      <td className="table-cell p-1 bg-green-50/10 group-hover:bg-green-50/30 border-r border-border">
                        <span className="block text-right font-mono text-muted-foreground">{item.newStockCases}</span>
                      </td>
                      {/* New Stk Btls */}
                      <td className="table-cell p-1 bg-green-50/10 group-hover:bg-green-50/30 border-r border-border">
                        <span className="block text-right font-mono text-muted-foreground">{item.newStockBottles}</span>
                      </td>
                      <td className="table-cell text-right font-mono text-muted-foreground border-r border-border">
                        {totalStock}
                      </td>
                      {/* Cls Bal Cs */}
                      <td className="table-cell p-1 bg-orange-50/30 border-r border-border">
                        {isSubmitted && !isAdmin ? (
                          <span className="block w-full text-center font-bold text-foreground py-1">{item.closingBalanceCases || 0}</span>
                        ) : (
                          <input
                            type="number" min="0"
                            value={item.closingBalanceCases ?? 0}
                            onChange={(e) => handleInputChange(item.id, "closingBalanceCases", e.target.value)}
                            data-testid={`input-closing-cases-${item.id}`}
                            className="w-full text-center p-1 rounded-md border border-orange-200 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none font-bold text-foreground bg-white shadow-sm"
                          />
                        )}
                      </td>
                      {/* Cls Bal Btls */}
                      <td className="table-cell p-1 bg-orange-50/30 border-r border-border">
                        {isSubmitted && !isAdmin ? (
                          <span className="block w-full text-center font-bold text-foreground py-1">{item.closingBalanceBottles || 0}</span>
                        ) : (
                          <input
                            type="number" min="0"
                            value={item.closingBalanceBottles ?? 0}
                            onChange={(e) => handleInputChange(item.id, "closingBalanceBottles", e.target.value)}
                            data-testid={`input-closing-bottles-${item.id}`}
                            className="w-full text-center p-1 rounded-md border border-orange-200 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none font-bold text-foreground bg-white shadow-sm"
                          />
                        )}
                      </td>
                      <td className={`table-cell text-center font-mono border-r border-border ${(item.soldBottles || 0) < 0 ? 'bg-red-100 text-red-700 font-bold dark:bg-red-900/30 dark:text-red-400' : ''}`}>
                        {item.soldBottles}
                        {(item.soldBottles || 0) < 0 && <span className="block text-[9px] text-red-500">⚠ negative</span>}
                      </td>
                      <td className="table-cell text-center font-mono bg-blue-50/10 group-hover:bg-blue-50/30 border-r border-border">
                        {editMrp}
                      </td>
                      <td className={`table-cell text-right font-bold font-mono border-r border-border ${parseFloat(String(item.saleValue)) < 0 ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' : 'text-primary'}`}>
                        {parseFloat(String(item.saleValue)) < 0 && <span className="mr-1">⚠</span>}
                        ₹{item.saleValue}
                      </td>
                      <td className="table-cell text-center font-mono border-r border-border">
                        {item.totalClosingStock}
                      </td>
                      {/* Breakage */}
                      <td className="table-cell p-1 border-r border-border">
                        {isSubmitted && !isAdmin ? (
                          <span className="block w-full text-center py-1">{item.breakageBottles || 0}</span>
                        ) : (
                          <input
                            type="number" min="0"
                            value={item.breakageBottles || 0}
                            onChange={(e) => handleInputChange(item.id, "breakageBottles", e.target.value)}
                            data-testid={`input-breakage-${item.id}`}
                            className="w-full text-center p-1 rounded-md border border-input focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none"
                          />
                        )}
                      </td>
                      <td className="table-cell text-center font-mono border-r border-border">
                        {Math.round(Number(item.finalClosingBalance) || 0)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <PaginationCustom
          currentPage={currentPage}
          totalPages={totalPages}
          pageSize={pageSize}
          onPageChange={setCurrentPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setCurrentPage(1);
          }}
          totalItems={filteredSales.length}
        />

        {!isSubmitted && !isDateAllowedForAction && (
          <div className="p-4 border-t border-border bg-secondary/20 flex justify-end gap-3">
            <div className="flex items-center gap-2 px-8 py-3 bg-amber-50 text-amber-700 rounded-xl font-bold border border-amber-200 dark:bg-amber-900/20 dark:border-amber-700 dark:text-amber-400" data-testid="status-date-restricted-footer">
              <Lock className="w-5 h-5" />
              Date outside allowed range
            </div>
          </div>
        )}
      </div>

      <Dialog open={exportDialogOpen} onOpenChange={(open) => {
        if (!isExporting) setExportDialogOpen(open);
      }}>
        <DialogContent className="sm:max-w-[480px]" data-testid="dialog-export-range">
          <DialogHeader>
            <DialogTitle>Export Sales to CSV</DialogTitle>
            <DialogDescription>
              Pick a single day or a date range. Same start and end date exports just that day.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">From</label>
                <Popover open={exportFromPickerOpen} onOpenChange={(o) => { if (!isExporting) setExportFromPickerOpen(o); }}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      disabled={isExporting}
                      data-testid="input-export-from-date"
                      className="w-full flex items-center gap-2 bg-background border border-input rounded-xl px-3 py-2 shadow-sm cursor-pointer hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <CalendarIcon className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm font-semibold text-foreground">
                        {format(parse(exportFromDate, "yyyy-MM-dd", new Date()), "dd-MM-yyyy")}
                      </span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={parse(exportFromDate, "yyyy-MM-dd", new Date())}
                      onSelect={(date) => {
                        if (date) {
                          const y = date.getFullYear();
                          const m = String(date.getMonth() + 1).padStart(2, "0");
                          const d = String(date.getDate()).padStart(2, "0");
                          const newFrom = `${y}-${m}-${d}`;
                          setExportFromDate(newFrom);
                          // Keep range valid: bump To forward if From moved past it.
                          if (newFrom > exportToDate) setExportToDate(newFrom);
                          setExportFromPickerOpen(false);
                        }
                      }}
                      disabled={(date) => {
                        const today = new Date();
                        today.setHours(0, 0, 0, 0);
                        return date > today;
                      }}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">To</label>
                <Popover open={exportToPickerOpen} onOpenChange={(o) => { if (!isExporting) setExportToPickerOpen(o); }}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      disabled={isExporting}
                      data-testid="input-export-to-date"
                      className="w-full flex items-center gap-2 bg-background border border-input rounded-xl px-3 py-2 shadow-sm cursor-pointer hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <CalendarIcon className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm font-semibold text-foreground">
                        {format(parse(exportToDate, "yyyy-MM-dd", new Date()), "dd-MM-yyyy")}
                      </span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={parse(exportToDate, "yyyy-MM-dd", new Date())}
                      onSelect={(date) => {
                        if (date) {
                          const y = date.getFullYear();
                          const m = String(date.getMonth() + 1).padStart(2, "0");
                          const d = String(date.getDate()).padStart(2, "0");
                          setExportToDate(`${y}-${m}-${d}`);
                          setExportToPickerOpen(false);
                        }
                      }}
                      disabled={(date) => {
                        const today = new Date();
                        today.setHours(0, 0, 0, 0);
                        const fromDate = parse(exportFromDate, "yyyy-MM-dd", new Date());
                        fromDate.setHours(0, 0, 0, 0);
                        return date > today || date < fromDate;
                      }}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            {exportFromDate !== exportToDate && (
              <div className="text-xs text-muted-foreground bg-secondary/40 border border-border rounded-lg px-3 py-2" data-testid="text-export-range-info">
                Exporting {enumerateDateRange(exportFromDate, exportToDate).length} day(s). The CSV will include a "Date" column.
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <button
              type="button"
              onClick={() => setExportDialogOpen(false)}
              disabled={isExporting}
              data-testid="button-export-cancel"
              className="px-4 py-2 rounded-xl border border-border bg-background hover:bg-accent text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleExportCSV}
              disabled={isExporting || exportFromDate > exportToDate}
              data-testid="button-export-confirm"
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isExporting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              Export
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
