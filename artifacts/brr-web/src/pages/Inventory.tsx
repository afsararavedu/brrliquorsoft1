import { useState, useRef, useEffect, useMemo } from "react";
import * as XLSX from "xlsx";
import {
  format, parse, isValid,
  subDays, startOfMonth, endOfMonth, startOfYear, endOfYear, startOfDay, endOfDay,
} from "date-fns";
import { useBulkCreateOrders, useUploadFile } from "@/hooks/use-orders";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import {
  UploadCloud,
  File,
  Plus,
  Trash2,
  Save,
  Loader2,
  FileSpreadsheet,
  CheckCircle2,
  XCircle,
  Search,
  Filter,
  X,
  Download,
  Store,
  Tag,
  Pencil,
  ChevronsUpDown,
  Check,
  CalendarIcon,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Settings2,
  RefreshCw,
  FileText,
  Package,
  ReceiptText,
  LayoutGrid,
  BarChart2,
  Trophy,
  TrendingUp,
  Upload,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Checkbox } from "@/components/ui/checkbox";
import { type InsertOrder, type Order, type ShopDetail, type SalesMrpDetail, type DailySale } from "@shared/schema";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { cn, formatDMY } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { PaginationCustom } from "@/components/ui/pagination-custom";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api } from "@shared/routes";
import { ImportSalesDataTab } from "@/components/ImportSalesDataTab";

const PRODUCT_TYPES = ["Beer", "IML", "Wine"];
const PACK_TYPES = ["G", "P", "Can"];
const PACK_SIZES = [
  "12 / 650 ml",
  "12 / 750 ml",
  "48 / 180 ml",
  "4 / 2000 ml",
  "96 / 90 ml",
  "9 / 1000 ml",
  "24 / 375 ml",
  "24 / 275 ml",
];

const EMPTY_ROW: InsertOrder = {
  brandNumber: "",
  brandName: "",
  productType: "Beer",
  packType: "G",
  packSize: "12 / 650 ml",
  qtyCasesDelivered: 0,
  qtyBottlesDelivered: 0,
  ratePerCase: "0",
  unitRatePerBottle: "0",
  totalAmount: "0",
  breakageBottleQty: 0,
  totalBottles: null,
  remarks: "",
  invoiceDate: "",
  icdcNumber: "",
  dataUpdated: "",
};

const fmt2 = (v: string | number | null | undefined): string => {
  const n = parseFloat(String(v ?? "0").replace(/,/g, ""));
  return isNaN(n) ? String(v ?? "0") : n.toFixed(2);
};

type SortField = "invoiceDate" | "brandNumber" | "brandName" | "qtyCasesDelivered" | "ratePerCase";
type SortDir = "asc" | "desc";

function parseDateStr(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = parse(s, "d-MMM-yyyy", new Date());
  return isValid(d) ? d : null;
}

/** Reusable date picker input — displays dd-MM-yyyy, stores yyyy-MM-dd. */
function DatePickerInput({ value, onChange, className, placeholder, testId }: {
  value: string | null | undefined;
  onChange: (val: string) => void;
  className?: string;
  placeholder?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const parsed = value && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? parse(value, "yyyy-MM-dd", new Date())
    : undefined;
  const display = value ? formatDMY(value) : "";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 border border-input rounded bg-background hover:bg-muted text-left text-xs font-mono",
            className,
          )}
        >
          <CalendarIcon className="w-3 h-3 text-muted-foreground shrink-0" />
          <span className={display ? "" : "text-muted-foreground"}>
            {display || placeholder || "Pick date"}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={parsed}
          defaultMonth={parsed}
          onSelect={(date) => {
            if (date) {
              const y = date.getFullYear();
              const m = String(date.getMonth() + 1).padStart(2, "0");
              const d = String(date.getDate()).padStart(2, "0");
              onChange(`${y}-${m}-${d}`);
              setOpen(false);
            }
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Convert YYYY-MM-DD (HTML date input) → DD-Mon-YYYY (PDF-parsed format, e.g. 05-Feb-2026) */
function toInvoiceDateFormat(val: string | null | undefined): string {
  if (!val) return val ?? "";
  // Already in DD-Mon-YYYY format — leave untouched
  if (/^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(val)) return val;
  // Convert from YYYY-MM-DD
  const d = parse(val, "yyyy-MM-dd", new Date());
  if (!isValid(d)) return val;
  return format(d, "dd-MMM-yyyy");
}

function SortOption({ field, dir, label, activeSortField, activeSortDir, onSort }: {
  field: SortField; dir: SortDir; label: string;
  activeSortField: SortField; activeSortDir: SortDir;
  onSort: (f: SortField, d: SortDir) => void;
}) {
  const active = activeSortField === field && activeSortDir === dir;
  return (
    <button
      onClick={() => onSort(field, dir)}
      className={cn("flex items-center gap-2 w-full px-3 py-1.5 text-sm rounded-md transition-colors", active ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted text-foreground")}
    >
      {dir === "asc" ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />}
      {label}
      {active && <Check className="w-3.5 h-3.5 ml-auto" />}
    </button>
  );
}

export default function Inventory() {
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ---- File Upload ----
  const { mutate: uploadFile, isPending: isUploading } = useUploadFile();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewOrders, setPreviewOrders] = useState<InsertOrder[]>([]);
  const [previewFilename, setPreviewFilename] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [previewPage, setPreviewPage] = useState(1);
  const previewPageSize = 10;

  // ---- Duplicate Invoice ----
  const [showDuplicateDialog, setShowDuplicateDialog] = useState(false);
  const [pendingUploadData, setPendingUploadData] = useState<any>(null);
  const [isCheckingDuplicate, setIsCheckingDuplicate] = useState(false);

  // ---- Manual Entry ----
  const { mutate: saveOrders, isPending: isSaving } = useBulkCreateOrders();
  const [rows, setRows] = useState<InsertOrder[]>([{ ...EMPTY_ROW }]);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [showManualEntryDialog, setShowManualEntryDialog] = useState(false);

  // ---- Active view/tab ----
  const [activeView, setActiveView] = useState<'invoices' | 'mrp' | 'import-sales'>('invoices');

  // Non-admins (employees) cannot see Sales MRP / Sales Records tabs;
  // coerce them back to Invoices if activeView is ever set to one of those.
  useEffect(() => {
    if (!isAdmin && (activeView === 'mrp' || activeView === 'import-sales')) {
      setActiveView('invoices');
    }
  }, [isAdmin, activeView]);

  // ---- New UI State ----
  const [searchQuery, setSearchQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [sortField, setSortField] = useState<SortField>("invoiceDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [filterFromDate, setFilterFromDate] = useState<Date | null>(null);
  const [filterToDate, setFilterToDate] = useState<Date | null>(null);
  const [filterIcdcNumber, setFilterIcdcNumber] = useState("");
  const [filterBrandNumber, setFilterBrandNumber] = useState("");
  const [quickRange, setQuickRange] = useState<string>("");
  const [savedPage, setSavedPage] = useState(1);
  const [savedPageSize, setSavedPageSize] = useState(25);

  // ---- Inline edit / delete ----
  const [editingOrderId, setEditingOrderId] = useState<number | null>(null);
  const [editOrderData, setEditOrderData] = useState<Partial<Order>>({});
  const [deleteConfirmOrderId, setDeleteConfirmOrderId] = useState<number | null>(null);
  const [dirtyOrderMap, setDirtyOrderMap] = useState<Map<number, Order>>(new Map());
  const [pendingDeleteOrderIds, setPendingDeleteOrderIds] = useState<Set<number>>(new Set());
  const [isUpdatingOrders, setIsUpdatingOrders] = useState(false);

  // ---- Shop Details ----
  const [showShopDetail, setShowShopDetail] = useState(false);
  const [selectedIcdcNumber, setSelectedIcdcNumber] = useState<string>("");

  // ---- MRP State ----

  const [brandNoComboOpen, setBrandNoComboOpen] = useState(false);
  const [mrpBrandNumber, setMrpBrandNumber] = useState("");
  const [mrpBrandName, setMrpBrandName] = useState("");
  const [mrpProductType, setMrpProductType] = useState("");
  const [mrpSize, setMrpSize] = useState("");
  const [mrpValue, setMrpValue] = useState<number | "">("");
  const [mrpEditId, setMrpEditId] = useState<number | null>(null);
  const mrpFileInputRef = useRef<HTMLInputElement>(null);
  const [mrpUploadFile, setMrpUploadFile] = useState<File | null>(null);
  const [isMrpUploading, setIsMrpUploading] = useState(false);
  const [mrpSearch, setMrpSearch] = useState("");
  const [mrpFilterOpen, setMrpFilterOpen] = useState(false);
  const [mrpSortOpen, setMrpSortOpen] = useState(false);
  const [mrpSortField, setMrpSortField] = useState<'brandNumber' | 'brandName' | 'productType' | 'size' | 'salesMrp'>('brandNumber');
  const [mrpSortDir, setMrpSortDir] = useState<'asc' | 'desc'>('asc');
  const [mrpFilterBrandNo, setMrpFilterBrandNo] = useState('');
  const [mrpFilterBrandName, setMrpFilterBrandName] = useState('');
  const [mrpPendingBrandNo, setMrpPendingBrandNo] = useState('');
  const [mrpPendingBrandName, setMrpPendingBrandName] = useState('');
  const [mrpFilterBrandNoComboOpen, setMrpFilterBrandNoComboOpen] = useState(false);
  const [mrpFilterDescComboOpen, setMrpFilterDescComboOpen] = useState(false);
  const [showMrpFormDialog, setShowMrpFormDialog] = useState(false);
  const [mrpSelectedIds, setMrpSelectedIds] = useState<Set<number>>(new Set());
  const [isBulkDeletingMrp, setIsBulkDeletingMrp] = useState(false);
  const [mrpCurrentPage, setMrpCurrentPage] = useState(1);
  const [mrpRowsPerPage, setMrpRowsPerPage] = useState(20);
  const [srSelectedIds, setSrSelectedIds] = useState<Set<number>>(new Set());
  const [isBulkDeletingSr, setIsBulkDeletingSr] = useState(false);

  // ---- Sales Records Tab State ----
  const srFileInputRef = useRef<HTMLInputElement>(null);
  const [srSearchQuery, setSrSearchQuery] = useState("");
  const [srSortField, setSrSortField] = useState<'saleDate' | 'brandNumber' | 'brandName' | 'soldBottles' | 'saleValue'>('saleDate');
  const [srSortDir, setSrSortDir] = useState<'asc' | 'desc'>('desc');
  const [srSortOpen, setSrSortOpen] = useState(false);
  const [srPage, setSrPage] = useState(1);
  const srPageSize = 25;
  const [isSrImporting, setIsSrImporting] = useState(false);

  // ---- Fetch All Orders ----
  const {
    data: allOrders,
    isLoading: isLoadingOrders,
    refetch: refetchOrders,
    dataUpdatedAt,
  } = useQuery<Order[]>({
    queryKey: ["/api/orders/all"],
    queryFn: async () => {
      const res = await fetch("/api/orders");
      if (!res.ok) throw new Error("Failed to fetch orders");
      return res.json();
    },
  });

  // Time ago display
  const [timeAgo, setTimeAgo] = useState("just now");
  useEffect(() => {
    if (!dataUpdatedAt) return;
    const update = () => {
      const diff = Date.now() - dataUpdatedAt;
      if (diff < 60000) setTimeAgo(`${Math.max(1, Math.floor(diff / 1000))}s ago`);
      else if (diff < 3600000) setTimeAgo(`${Math.floor(diff / 60000)}m ago`);
      else setTimeAgo(`${Math.floor(diff / 3600000)}h ago`);
    };
    update();
    const id = setInterval(update, 15000);
    return () => clearInterval(id);
  }, [dataUpdatedAt]);

  // ---- MRP Queries ----
  const { data: allOrdersForMrp } = useQuery<Order[]>({
    queryKey: ["/api/orders/all-for-mrp"],
    queryFn: async () => {
      const res = await fetch("/api/orders");
      if (!res.ok) throw new Error("Failed to fetch orders");
      return res.json();
    },
  });
  const { data: salesMrpData, isLoading: isLoadingMrp } = useQuery<SalesMrpDetail[]>({
    queryKey: ["/api/sales-mrp"],
    queryFn: async () => {
      const res = await fetch("/api/sales-mrp");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });
  // ---- Sales Records Data ----
  const { data: allSalesData, isLoading: isLoadingSales, refetch: refetchSales } = useQuery<DailySale[]>({
    queryKey: ["/api/sales/all"],
  });

  const { mutate: saveSalesMrp, isPending: isSavingMrp } = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch("/api/sales-mrp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({ message: "Failed" })); throw new Error(e.message); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sales-mrp"] });
      toast({ title: "Saved", description: "Sales MRP updated.", className: "bg-green-50 text-green-800" });
      setMrpBrandNumber(""); setMrpBrandName(""); setMrpProductType(""); setMrpSize(""); setMrpValue(""); setMrpEditId(null);
      setShowMrpFormDialog(false);
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });
  const { mutate: deleteSalesMrp, isPending: isDeletingMrp } = useMutation({
    mutationFn: async (id: number) => { const res = await apiRequest("DELETE", `/api/sales-mrp/${id}`); return res.json(); },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/sales-mrp"] }); toast({ title: "Deleted", className: "bg-green-50 text-green-800" }); },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  // Unique values for MRP filter comboboxes (from full dataset, not cascaded)
  const uniqueFilterMrpBrandNos = Array.from(new Set((salesMrpData || []).map(r => r.brandNumber))).sort();
  const uniqueFilterMrpBrandNames = Array.from(new Set((salesMrpData || []).map(r => r.brandName))).sort();

  // MRP cascading dropdowns
  const allMrpOrders = allOrdersForMrp || [];
  const extractMrpSize = (packSize: string) => { const p = packSize.split("/"); return p.length >= 2 ? p[1].trim() : packSize.trim(); };
  const uniqueBrandNumbers = Array.from(new Set(allMrpOrders.map(o => o.brandNumber))).sort();
  const filteredByBrandNo = allMrpOrders.filter(o => o.brandNumber === mrpBrandNumber);
  const uniqueBrandNames = Array.from(new Set(filteredByBrandNo.map(o => o.brandName))).sort();
  const filteredByBrandName = filteredByBrandNo.filter(o => !mrpBrandName || o.brandName === mrpBrandName);
  const uniqueTypes = Array.from(new Set(filteredByBrandName.map(o => o.productType))).sort();
  const filteredByType = filteredByBrandName.filter(o => !mrpProductType || o.productType === mrpProductType);
  const uniqueSizes = Array.from(new Set(filteredByType.map(o => extractMrpSize(o.packSize)))).sort();

  // ---- Client-side filter + sort ----
  const displayOrders = useMemo(() => {
    let orders = [...(allOrders || [])];
    // Remove pending deletes
    orders = orders.filter(o => !pendingDeleteOrderIds.has(o.id));
    // Apply dirty edits
    orders = orders.map(o => dirtyOrderMap.get(o.id) ?? o);
    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      orders = orders.filter(o =>
        o.brandNumber.toLowerCase().includes(q) ||
        o.brandName.toLowerCase().includes(q) ||
        (o.icdcNumber || "").toLowerCase().includes(q)
      );
    }
    // Date range
    if (filterFromDate || filterToDate) {
      orders = orders.filter(o => {
        const d = parseDateStr(o.invoiceDate);
        if (!d) return false;
        if (filterFromDate && d < startOfDay(filterFromDate)) return false;
        if (filterToDate && d > endOfDay(filterToDate)) return false;
        return true;
      });
    }
    // ICDC filter
    if (filterIcdcNumber.trim()) {
      const q = filterIcdcNumber.toLowerCase();
      orders = orders.filter(o => (o.icdcNumber || "").toLowerCase().includes(q));
    }
    // Brand No filter
    if (filterBrandNumber.trim()) {
      const q = filterBrandNumber.toLowerCase();
      orders = orders.filter(o => o.brandNumber.toLowerCase().includes(q));
    }
    // Sort
    orders.sort((a, b) => {
      let av: any, bv: any;
      switch (sortField) {
        case "invoiceDate": {
          const da = parseDateStr(a.invoiceDate); const db = parseDateStr(b.invoiceDate);
          av = da ? da.getTime() : 0; bv = db ? db.getTime() : 0; break;
        }
        case "brandNumber": av = a.brandNumber; bv = b.brandNumber; break;
        case "brandName": av = a.brandName; bv = b.brandName; break;
        case "qtyCasesDelivered": av = a.qtyCasesDelivered; bv = b.qtyCasesDelivered; break;
        case "ratePerCase": av = parseFloat(a.ratePerCase || "0"); bv = parseFloat(b.ratePerCase || "0"); break;
        default: av = 0; bv = 0;
      }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return orders;
  }, [allOrders, searchQuery, filterFromDate, filterToDate, filterIcdcNumber, filterBrandNumber, sortField, sortDir, pendingDeleteOrderIds, dirtyOrderMap]);

  // ---- Stats ----
  const stats = useMemo(() => {
    const orders = allOrders || [];
    const uniqueIcdc = new Set(orders.filter(o => o.icdcNumber).map(o => o.icdcNumber)).size;
    const totalCases = orders.reduce((s, o) => s + (o.qtyCasesDelivered || 0), 0);
    const totalBottles = orders.reduce((s, o) => s + (o.qtyBottlesDelivered || 0), 0);
    const totalValue = orders.reduce((s, o) => s + parseFloat(o.totalAmount || "0"), 0);
    const now = new Date();
    const thisMonthLines = orders.filter(o => {
      const d = parseDateStr(o.invoiceDate);
      return d && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length;
    return { uniqueIcdc, totalCases, totalBottles, totalValue, thisMonthLines };
  }, [allOrders]);

  const hasActiveFilters = !!(filterFromDate || filterToDate || filterIcdcNumber || filterBrandNumber);

  // ---- Sales Records computed ----
  const salesStats = useMemo(() => {
    const rows = allSalesData ?? [];
    const totalRevenue = rows.reduce((s, r) => s + parseFloat((r.totalSaleValue ?? r.saleValue ?? '0') as string), 0);
    const bottlesSold = rows.reduce((s, r) => s + (r.soldBottles ?? 0), 0);
    const uniqueDates = new Set(rows.map(r => r.saleDate)).size;
    const brandBottles: Record<string, number> = {};
    rows.forEach(r => { if (r.brandName) brandBottles[r.brandName] = (brandBottles[r.brandName] ?? 0) + (r.soldBottles ?? 0); });
    const topBrand = Object.entries(brandBottles).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';
    return { totalRevenue, bottlesSold, topBrand, daysTracked: uniqueDates, totalLines: rows.length };
  }, [allSalesData]);

  const displaySales = useMemo(() => {
    let rows = allSalesData ?? [];
    if (srSearchQuery) {
      const q = srSearchQuery.toLowerCase();
      rows = rows.filter(r => (r.saleDate ?? '').includes(q) || r.brandNumber.toLowerCase().includes(q) || r.brandName.toLowerCase().includes(q));
    }
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (srSortField === 'saleDate') cmp = (a.saleDate ?? '').localeCompare(b.saleDate ?? '');
      else if (srSortField === 'brandNumber') cmp = a.brandNumber.localeCompare(b.brandNumber);
      else if (srSortField === 'brandName') cmp = a.brandName.localeCompare(b.brandName);
      else if (srSortField === 'soldBottles') cmp = (a.soldBottles ?? 0) - (b.soldBottles ?? 0);
      else if (srSortField === 'saleValue') cmp = parseFloat((a.totalSaleValue ?? '0') as string) - parseFloat((b.totalSaleValue ?? '0') as string);
      return srSortDir === 'asc' ? cmp : -cmp;
    });
  }, [allSalesData, srSearchQuery, srSortField, srSortDir]);

  const displayMrpRecords = useMemo(() => {
    let records = [...(salesMrpData || [])];
    if (mrpSearch.trim()) {
      const q = mrpSearch.toLowerCase();
      records = records.filter(r => r.brandNumber.toLowerCase().includes(q) || r.brandName.toLowerCase().includes(q));
    }
    if (mrpFilterBrandNo.trim()) {
      records = records.filter(r => r.brandNumber.toLowerCase().includes(mrpFilterBrandNo.toLowerCase()));
    }
    if (mrpFilterBrandName.trim()) {
      records = records.filter(r => r.brandName.toLowerCase().includes(mrpFilterBrandName.toLowerCase()));
    }
    records.sort((a, b) => {
      let av: any, bv: any;
      switch (mrpSortField) {
        case 'brandNumber': av = a.brandNumber; bv = b.brandNumber; break;
        case 'brandName': av = a.brandName; bv = b.brandName; break;
        case 'productType': av = a.productType ?? ''; bv = b.productType ?? ''; break;
        case 'size': av = a.size; bv = b.size; break;
        case 'salesMrp': av = parseFloat(a.salesMrp as string); bv = parseFloat(b.salesMrp as string); break;
        default: av = ''; bv = '';
      }
      if (av < bv) return mrpSortDir === 'asc' ? -1 : 1;
      if (av > bv) return mrpSortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return records;
  }, [salesMrpData, mrpSearch, mrpFilterBrandNo, mrpFilterBrandName, mrpSortField, mrpSortDir]);

  const mrpTotalPages = Math.max(1, Math.ceil(displayMrpRecords.length / mrpRowsPerPage));
  const mrpPageStart = (mrpCurrentPage - 1) * mrpRowsPerPage;
  const paginatedMrpRecords = displayMrpRecords.slice(mrpPageStart, mrpPageStart + mrpRowsPerPage);

  const hasMrpActiveFilters = !!(mrpFilterBrandNo || mrpFilterBrandName);

  useEffect(() => {
    setMrpCurrentPage(1);
  }, [mrpSearch, mrpFilterBrandNo, mrpFilterBrandName, mrpSortField, mrpSortDir]);

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(displayMrpRecords.length / mrpRowsPerPage));
    if (mrpCurrentPage > maxPage) setMrpCurrentPage(maxPage);
  }, [displayMrpRecords.length, mrpRowsPerPage]);

  const handleMrpOpenFilter = () => {
    setMrpPendingBrandNo(mrpFilterBrandNo);
    setMrpPendingBrandName(mrpFilterBrandName);
    setMrpFilterOpen(true);
  };
  const handleMrpApplyFilter = () => {
    setMrpFilterBrandNo(mrpPendingBrandNo);
    setMrpFilterBrandName(mrpPendingBrandName);
    setMrpFilterOpen(false);
    setMrpCurrentPage(1);
  };
  const handleMrpResetFilter = () => {
    setMrpPendingBrandNo('');
    setMrpPendingBrandName('');
  };
  const handleMrpSetSort = (field: typeof mrpSortField, dir: 'asc' | 'desc') => {
    setMrpSortField(field); setMrpSortDir(dir); setMrpSortOpen(false);
  };

  const handleSrImport = async (file: File) => {
    setIsSrImporting(true);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/sales/import-archive', { method: 'POST', body: fd, credentials: 'include' });
      const data = await res.json();
      if (res.ok) {
        toast({ title: 'Import successful', description: data.message });
        refetchSales();
      } else {
        toast({ title: 'Import failed', description: data.message, variant: 'destructive' });
      }
    } catch (e: any) {
      toast({ title: 'Import error', description: String(e?.message), variant: 'destructive' });
    } finally {
      setIsSrImporting(false);
      if (srFileInputRef.current) srFileInputRef.current.value = '';
    }
  };

  // ---- Pending applied filter state for filter popover ----
  const [pendingFromDate, setPendingFromDate] = useState<Date | null>(null);
  const [pendingToDate, setPendingToDate] = useState<Date | null>(null);
  const [pendingIcdc, setPendingIcdc] = useState("");
  const [pendingBrand, setPendingBrand] = useState("");
  const [pendingQuick, setPendingQuick] = useState("");

  const openFilterPopover = () => {
    setPendingFromDate(filterFromDate);
    setPendingToDate(filterToDate);
    setPendingIcdc(filterIcdcNumber);
    setPendingBrand(filterBrandNumber);
    setPendingQuick(quickRange);
    setFilterOpen(true);
  };
  const applyFilters = () => {
    setFilterFromDate(pendingFromDate);
    setFilterToDate(pendingToDate);
    setFilterIcdcNumber(pendingIcdc);
    setFilterBrandNumber(pendingBrand);
    setQuickRange(pendingQuick);
    setSavedPage(1);
    setFilterOpen(false);
  };
  const resetFilters = () => {
    setPendingFromDate(null); setPendingToDate(null); setPendingIcdc(""); setPendingBrand(""); setPendingQuick("");
  };
  const clearAllFilters = () => {
    setFilterFromDate(null); setFilterToDate(null); setFilterIcdcNumber(""); setFilterBrandNumber(""); setQuickRange(""); setSavedPage(1);
  };

  const applyQuickRange = (label: string) => {
    const today = new Date();
    let from: Date | null = null, to: Date | null = null;
    if (label === "Today") { from = startOfDay(today); to = endOfDay(today); }
    else if (label === "Last 7 d") { from = subDays(today, 7); to = today; }
    else if (label === "Last 30 d") { from = subDays(today, 30); to = today; }
    else if (label === "This month") { from = startOfMonth(today); to = endOfMonth(today); }
    else if (label === "This year") { from = startOfYear(today); to = endOfYear(today); }
    setPendingFromDate(from); setPendingToDate(to); setPendingQuick(label);
  };

  // ---- Sort helpers ----
  const handleSetSort = (field: SortField, dir: SortDir) => {
    setSortField(field); setSortDir(dir); setSortOpen(false);
  };

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const isInput = ["INPUT", "TEXTAREA", "SELECT"].includes(tag) || (e.target as HTMLElement).isContentEditable;
      if (e.key === "/" && !isInput) { e.preventDefault(); searchInputRef.current?.focus(); }
      if (e.key === "n" && !isInput) { e.preventDefault(); if (user?.role === "admin") setShowManualEntryDialog(true); }
      if (e.key === "r" && !isInput) { e.preventDefault(); refetchOrders(); }
      if (e.key === "Escape") { setEditingOrderId(null); setEditOrderData({}); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [refetchOrders, user]);

  // Reset dirty state only when explicitly requested (via refetch after save)

  // ---- Handlers ----
  const handleViewShopDetail = (icdcNum: string) => { if (!icdcNum) return; setSelectedIcdcNumber(icdcNum); setShowShopDetail(true); };

  const { data: shopDetailData, isLoading: isLoadingShopDetail } = useQuery<ShopDetail & Record<string, unknown>>({
    queryKey: ["/api/shop-details/by-icdc", selectedIcdcNumber],
    queryFn: async () => { const res = await fetch(`/api/shop-details/by-icdc/${encodeURIComponent(selectedIcdcNumber)}`); if (!res.ok) return null; return res.json(); },
    enabled: showShopDetail && !!selectedIcdcNumber,
  });

  const handleExportOrders = () => {
    const orders = displayOrders;
    if (!orders || orders.length === 0) return;
    const headers = ["Invoice Date", "ICDC Number", "Brand No", "Brand Name", "Type", "Pack", "Pack Size", "Cases Delivered", "Bottles Delivered", "Rate/Case", "Rate/Bottle", "Total Amount", "Breakage", "Total Bottles"];
    const csvRows = orders.map((o: Order) => [o.invoiceDate || "", o.icdcNumber || "", o.brandNumber, o.brandName, o.productType, o.packType, o.packSize, o.qtyCasesDelivered, o.qtyBottlesDelivered, o.ratePerCase, o.unitRatePerBottle, o.totalAmount, o.breakageBottleQty, o.totalBottles].map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","));
    const csv = [headers.join(","), ...csvRows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `orders_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Exported", description: `${orders.length} orders exported.`, className: "bg-green-50 text-green-800" });
  };

  const handleOrderEditStart = (order: Order) => { setEditingOrderId(order.id); setEditOrderData({ ...order }); setDeleteConfirmOrderId(null); };
  const handleOrderEditField = (field: keyof Order, value: string | number) => setEditOrderData(prev => ({ ...prev, [field]: value }));
  const handleOrderEditSave = () => {
    if (editingOrderId === null) return;
    const base = (allOrders || []).find(o => o.id === editingOrderId) ?? ({} as Order);
    const merged: Order = { ...base, ...editOrderData } as Order;
    setDirtyOrderMap(prev => { const next = new Map(prev); next.set(editingOrderId, merged); return next; });
    setEditingOrderId(null); setEditOrderData({});
  };
  const handleOrderEditCancel = () => { setEditingOrderId(null); setEditOrderData({}); };
  const handleOrderDeleteConfirm = (id: number) => {
    setPendingDeleteOrderIds(prev => { const next = new Set(prev); next.add(id); return next; });
    setDirtyOrderMap(prev => { const next = new Map(prev); next.delete(id); return next; });
    setDeleteConfirmOrderId(null);
  };
  const handleUpdateOrders = async () => {
    const modifiedRows = Array.from(dirtyOrderMap.values());
    const deleteIds = Array.from(pendingDeleteOrderIds);
    if (modifiedRows.length === 0 && deleteIds.length === 0) { toast({ title: "Nothing to update", className: "bg-yellow-50 text-yellow-800" }); return; }
    setIsUpdatingOrders(true);
    try {
      await Promise.all([
        ...modifiedRows.map(o => apiRequest("PUT", `/api/orders/${o.id}`, o)),
        ...deleteIds.map(id => apiRequest("DELETE", `/api/orders/${id}`)),
      ]);
      setDirtyOrderMap(new Map()); setPendingDeleteOrderIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/orders/all"] });
      queryClient.invalidateQueries({ queryKey: [api.sales.list.path] });
      queryClient.invalidateQueries({ queryKey: ["/api/sales/prevday"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock"] });
      toast({ title: "Orders Updated", description: `${modifiedRows.length > 0 ? `${modifiedRows.length} updated` : ""}${modifiedRows.length > 0 && deleteIds.length > 0 ? ", " : ""}${deleteIds.length > 0 ? `${deleteIds.length} deleted` : ""}.`, className: "bg-green-50 text-green-800" });
    } catch (err: any) {
      toast({ title: "Update Failed", description: err.message, variant: "destructive" });
    } finally { setIsUpdatingOrders(false); }
  };

  const totalManualPages = Math.ceil(rows.length / pageSize);
  const paginatedRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => { if (e.target.files && e.target.files[0]) setSelectedFile(e.target.files[0]); };
  useEffect(() => {
    if (selectedFile) handleUpload();
  }, [selectedFile]);

  const proceedWithPreview = (data: any) => {
    if (data.orders && data.orders.length > 0) {
      setPreviewOrders(data.orders.map((o: any) => ({ ...EMPTY_ROW, ...o })));
      setPreviewFilename(data.filename || "Uploaded File");
      setPreviewPage(1); setShowPreview(true);
    }
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (data.skippedCount && data.skippedCount > 0) {
      const details = (data.skippedLines as string[]).map(l => l.replace(/^brandNo=/, "Brand ").replace(/ rest=".+$/, "")).join(", ");
      toast({ title: `⚠️ ${data.skippedCount} row(s) skipped`, description: `Unrecognised size/pack format: ${details}.`, variant: "destructive", duration: 12000 });
    }
  };

  const handleUpload = () => {
    if (!selectedFile) return;
    const formData = new FormData();
    formData.append("file", selectedFile);
    uploadFile(formData, {
      onSuccess: async (data: any) => {
        const invoiceDate = data.shopDetail?.invoiceDate || data.orders?.[0]?.invoiceDate || "";
        const icdcNumber = data.shopDetail?.icdcNumber || data.orders?.[0]?.icdcNumber || "";
        if (invoiceDate || icdcNumber) {
          setIsCheckingDuplicate(true);
          try {
            const params = new URLSearchParams();
            if (invoiceDate) params.append("invoice_date", invoiceDate);
            if (icdcNumber) params.append("icdc_number", icdcNumber);
            const res = await fetch(`/api/orders/check-invoice?${params}`);
            const check = await res.json();
            setIsCheckingDuplicate(false);
            if (check.exists) { setPendingUploadData(data); setShowDuplicateDialog(true); return; }
          } catch { setIsCheckingDuplicate(false); }
        }
        proceedWithPreview(data);
      },
      onError: (err: any) => toast({ title: "Upload Failed", description: err?.message || "Could not upload the file.", variant: "destructive" }),
    });
  };

  const handleRowChange = (index: number, field: keyof InsertOrder, value: any) => {
    const gi = (currentPage - 1) * pageSize + index;
    const newRows = [...rows]; newRows[gi] = { ...newRows[gi], [field]: value };
    if (["qtyCasesDelivered", "qtyBottlesDelivered", "ratePerCase", "unitRatePerBottle"].includes(field)) {
      const r = newRows[gi];
      const total = (Number(r.qtyCasesDelivered) || 0) * (parseFloat(r.ratePerCase as string) || 0) + (Number(r.qtyBottlesDelivered) || 0) * (parseFloat(r.unitRatePerBottle as string) || 0);
      newRows[gi].totalAmount = total.toFixed(2);
    }
    setRows(newRows);
  };
  const addRow = () => setRows([...rows, { ...EMPTY_ROW }]);
  const removeRow = (index: number) => {
    const gi = (currentPage - 1) * pageSize + index;
    if (rows.length === 1) return;
    const newRows = rows.filter((_, i) => i !== gi);
    setRows(newRows);
    if (currentPage > Math.ceil(newRows.length / pageSize)) setCurrentPage(Math.max(1, currentPage - 1));
  };
  const handleConfirmUpload = () => {
    if (previewOrders.length === 0) return;
    saveOrders(previewOrders, {
      onSuccess: () => {
        toast({ title: "Success", description: `${previewOrders.length} orders saved!`, className: "bg-green-50 text-green-800" });
        setShowPreview(false); setPreviewOrders([]);
        queryClient.invalidateQueries({ queryKey: ["/api/orders/all"] });
      },
      onError: () => toast({ title: "Error", description: "Failed to save orders.", variant: "destructive" }),
    });
  };
  const handleRejectUpload = () => { setShowPreview(false); setPreviewOrders([]); toast({ title: "Cancelled", className: "bg-muted text-foreground" }); };
  const handleSubmitOrders = () => {
    if (rows.some(r => !r.brandName || !r.brandNumber)) { toast({ title: "Validation Error", description: "Fill in Brand Number and Name for all rows.", variant: "destructive" }); return; }
    const normalizedRows = rows.map(r => ({ ...r, invoiceDate: toInvoiceDateFormat(r.invoiceDate) }));
    saveOrders(normalizedRows, {
      onSuccess: () => {
        toast({ title: "Success", description: "Orders saved!", className: "bg-green-50 text-green-800" });
        setRows([{ ...EMPTY_ROW }]); setShowManualEntryDialog(false);
        queryClient.invalidateQueries({ queryKey: ["/api/orders/all"] });
      },
      onError: () => toast({ title: "Error", description: "Failed to save orders.", variant: "destructive" }),
    });
  };

  const previewTotalPages = Math.ceil(previewOrders.length / previewPageSize);
  const paginatedPreview = previewOrders.slice((previewPage - 1) * previewPageSize, previewPage * previewPageSize);

  // MRP handlers
  const handleMrpBrandNumberChange = (val: string) => { setMrpBrandNumber(val); setMrpBrandName(""); setMrpProductType(""); setMrpSize(""); };
  const handleMrpBrandNameChange = (val: string) => { setMrpBrandName(val); setMrpProductType(""); setMrpSize(""); };
  const handleMrpTypeChange = (val: string) => { setMrpProductType(val); setMrpSize(""); };
  const handleLoadMrpEdit = (row: SalesMrpDetail) => { setMrpEditId(row.id); setMrpBrandNumber(row.brandNumber); setMrpBrandName(row.brandName); setMrpProductType(row.productType ?? ""); setMrpSize(row.size); setMrpValue(parseFloat(row.salesMrp as string)); setShowMrpFormDialog(true); };
  const handleSaveMrp = () => {
    if (!mrpBrandNumber || !mrpBrandName || !mrpProductType || !mrpSize || mrpValue === "") { toast({ title: "Validation Error", description: "Fill in all fields.", variant: "destructive" }); return; }
    if (Number(mrpValue) < 0) { toast({ title: "Validation Error", description: "Sales MRP must not be less than 0.", variant: "destructive" }); return; }
    saveSalesMrp({ brandNumber: mrpBrandNumber, brandName: mrpBrandName, size: mrpSize, productType: mrpProductType, salesMrp: String(mrpValue) });
  };
  const handleDeleteMrp = (id: number) => { if (!confirm("Delete this Sales MRP record?")) return; deleteSalesMrp(id); };

  const visibleMrpIds = paginatedMrpRecords.map(r => r.id);
  const allVisibleMrpSelected = visibleMrpIds.length > 0 && visibleMrpIds.every(id => mrpSelectedIds.has(id));
  const someVisibleMrpSelected = visibleMrpIds.some(id => mrpSelectedIds.has(id)) && !allVisibleMrpSelected;

  const toggleMrpSelectAll = () => {
    if (allVisibleMrpSelected) {
      setMrpSelectedIds(prev => { const next = new Set(prev); visibleMrpIds.forEach(id => next.delete(id)); return next; });
    } else {
      setMrpSelectedIds(prev => { const next = new Set(prev); visibleMrpIds.forEach(id => next.add(id)); return next; });
    }
  };

  const toggleMrpRow = (id: number) => {
    setMrpSelectedIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };

  const handleBulkDeleteMrp = () => {
    const ids = Array.from(mrpSelectedIds);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} selected MRP record${ids.length === 1 ? "" : "s"}?`)) return;
    setMrpSelectedIds(new Set());

    let undone = false;

    const { dismiss } = toast({
      title: `Deleting ${ids.length} record${ids.length === 1 ? "" : "s"}…`,
      description: "Click Undo to cancel before deletion completes.",
      className: "bg-green-50 text-green-800",
      duration: 5500,
      action: (
        <ToastAction
          altText="Undo delete"
          data-testid="button-undo-bulk-delete-mrp"
          onClick={() => {
            undone = true;
            dismiss();
            toast({ title: "Deletion cancelled", description: "Your records have been restored.", className: "bg-blue-50 text-blue-800" });
          }}
        >
          Undo
        </ToastAction>
      ),
    });

    setTimeout(async () => {
      if (undone) return;
      dismiss();
      setIsBulkDeletingMrp(true);
      try {
        await apiRequest("DELETE", "/api/sales-mrp", { ids });
        queryClient.invalidateQueries({ queryKey: ["/api/sales-mrp"] });
        toast({ title: `Deleted ${ids.length} record${ids.length === 1 ? "" : "s"}`, className: "bg-green-50 text-green-800" });
      } catch (err: any) {
        toast({ title: "Error deleting records", description: err.message, variant: "destructive" });
        setMrpSelectedIds(new Set(ids));
      } finally {
        setIsBulkDeletingMrp(false);
      }
    }, 5000);
  };
  const visibleSrIds = displaySales.slice((srPage - 1) * srPageSize, srPage * srPageSize).map(r => r.id);
  const allVisibleSrSelected = visibleSrIds.length > 0 && visibleSrIds.every(id => srSelectedIds.has(id));
  const someVisibleSrSelected = visibleSrIds.some(id => srSelectedIds.has(id)) && !allVisibleSrSelected;

  const toggleSrSelectAll = () => {
    if (allVisibleSrSelected) {
      setSrSelectedIds(prev => { const next = new Set(prev); visibleSrIds.forEach(id => next.delete(id)); return next; });
    } else {
      setSrSelectedIds(prev => { const next = new Set(prev); visibleSrIds.forEach(id => next.add(id)); return next; });
    }
  };

  const toggleSrRow = (id: number) => {
    setSrSelectedIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };

  const handleBulkDeleteSr = async () => {
    const ids = Array.from(srSelectedIds);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} selected sales record${ids.length === 1 ? "" : "s"}?`)) return;
    setIsBulkDeletingSr(true);
    try {
      await apiRequest("DELETE", "/api/sales", { ids });
      setSrSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/sales/all"] });
      toast({ title: `Deleted ${ids.length} record${ids.length === 1 ? "" : "s"}`, className: "bg-green-50 text-green-800" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setIsBulkDeletingSr(false);
    }
  };

  const handleMrpBulkUpload = async () => {
    if (!mrpUploadFile) return; setIsMrpUploading(true);
    try {
      const formData = new FormData(); formData.append("file", mrpUploadFile);
      const res = await fetch("/api/sales-mrp/bulk-upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Upload failed");
      toast({ title: "Import Successful", description: data.message, className: "bg-green-50 text-green-800" });
      queryClient.invalidateQueries({ queryKey: ["/api/sales-mrp"] });
      setMrpUploadFile(null); if (mrpFileInputRef.current) mrpFileInputRef.current.value = "";
    } catch (err: any) { toast({ title: "Import Failed", description: err.message, variant: "destructive" }); }
    finally { setIsMrpUploading(false); }
  };

  const paginatedDisplay = displayOrders.slice((savedPage - 1) * savedPageSize, savedPage * savedPageSize);

  return (
    <div className="flex flex-col gap-4 animate-in slide-in-from-bottom-4 duration-500">

      {/* Hidden file input */}
      <input ref={fileInputRef} type="file" accept=".csv,.xls,.xlsx,.pdf" onChange={handleFileChange} className="hidden" />

      {/* ===================== PAGE HEADING ===================== */}
      <div>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Package className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Inventory</h1>
            <p className="text-sm text-muted-foreground">Manage invoices, MRP, and sales records</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-border pb-0">
          <button
            onClick={() => setActiveView('invoices')}
            data-testid="tab-invoices"
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${activeView === 'invoices' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground'}`}
          >
            <FileText className="w-3.5 h-3.5" />
            Invoices
            <span className={`px-1.5 py-0.5 text-xs rounded-full font-medium ${activeView === 'invoices' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>{allOrders?.length ?? 0}</span>
          </button>
          {isAdmin && (
            <button
              onClick={() => setActiveView('mrp')}
              data-testid="tab-update-sales-mrp"
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${activeView === 'mrp' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground'}`}
            >
              <Tag className="w-3.5 h-3.5" />
              Sales MRP
              <span className={`px-1.5 py-0.5 text-xs rounded-full font-medium ${activeView === 'mrp' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>{salesMrpData?.length ?? 0}</span>
            </button>
          )}
          {isAdmin && (
            <button
              onClick={() => setActiveView('import-sales')}
              data-testid="tab-sales-records"
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${activeView === 'import-sales' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground'}`}
            >
              <BarChart2 className="w-3.5 h-3.5" />
              Sales Records
              <span className={`px-1.5 py-0.5 text-xs rounded-full font-medium ${activeView === 'import-sales' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>{allSalesData?.length ?? 0}</span>
            </button>
          )}
        </div>
      </div>

      {/* ===================== STATS CARDS ===================== */}
      {activeView === 'invoices' ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-card border border-border rounded-xl p-4 flex items-start justify-between shadow-sm">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">ICDC Invoices</p>
              <p className="text-2xl font-bold text-foreground">{stats.uniqueIcdc}</p>
            </div>
            <div className="p-2 bg-primary/5 rounded-lg"><ReceiptText className="w-5 h-5 text-primary" /></div>
          </div>
          <div className="bg-card border border-border rounded-xl p-4 flex items-start justify-between shadow-sm">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Total Cases</p>
              <p className="text-2xl font-bold text-foreground">{stats.totalCases.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{stats.totalBottles.toLocaleString()} bottles</p>
            </div>
            <div className="p-2 bg-blue-50 rounded-lg"><Package className="w-5 h-5 text-blue-600" /></div>
          </div>
          <div className="bg-card border border-border rounded-xl p-4 flex items-start justify-between shadow-sm">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Stock Value</p>
              <p className="text-2xl font-bold text-foreground">₹{Math.round(stats.totalValue).toLocaleString('en-IN')}</p>
            </div>
            <div className="p-2 bg-green-50 rounded-lg"><LayoutGrid className="w-5 h-5 text-green-600" /></div>
          </div>
          <div className="bg-card border border-border rounded-xl p-4 flex items-start justify-between shadow-sm">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">This Month</p>
              <p className="text-2xl font-bold text-foreground">{stats.thisMonthLines} <span className="text-base font-normal text-muted-foreground">lines</span></p>
            </div>
            <div className="p-2 bg-orange-50 rounded-lg"><CalendarIcon className="w-5 h-5 text-orange-500" /></div>
          </div>
        </div>
      ) : activeView === 'mrp' ? (
        /* ===== Inline Add Sales MRP Form ===== */
        <div className="bg-card border border-border rounded-xl px-4 py-3 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <Tag className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold text-foreground">Add Sales MRP</span>
            <span className="text-xs text-muted-foreground">Select brand details and enter the Sales MRP.</span>
          </div>
          <div className="flex flex-wrap gap-3 items-end">
            {/* Brand No */}
            <div className="flex flex-col gap-1 min-w-[120px] flex-1">
              <label className="text-xs font-medium text-muted-foreground">Brand No</label>
              <Popover open={brandNoComboOpen} onOpenChange={setBrandNoComboOpen}>
                <PopoverTrigger asChild>
                  <button data-testid="inline-select-mrp-brand-number" className="input-field flex items-center justify-between text-left w-full" role="combobox">
                    <span className={mrpBrandNumber ? "text-foreground text-sm" : "text-muted-foreground text-sm"}>{mrpBrandNumber || "-- Select --"}</span>
                    <ChevronsUpDown className="w-3.5 h-3.5 shrink-0 opacity-50 ml-1" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-[200px] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search brand no..." />
                    <CommandList>
                      <CommandEmpty>No brand found.</CommandEmpty>
                      <CommandGroup>
                        {uniqueBrandNumbers.map(bn => (
                          <CommandItem key={bn} value={bn} onSelect={val => { const original = uniqueBrandNumbers.find(n => n.toLowerCase() === val.toLowerCase()) ?? val; handleMrpBrandNumberChange(original === mrpBrandNumber ? "" : original); setBrandNoComboOpen(false); }}>
                            <Check className={cn("mr-2 h-4 w-4", mrpBrandNumber === bn ? "opacity-100" : "opacity-0")} />{bn}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            {/* Brand Name */}
            <div className="flex flex-col gap-1 min-w-[160px] flex-[2]">
              <label className="text-xs font-medium text-muted-foreground">Brand Name</label>
              <select className="input-field w-full text-sm" value={mrpBrandName} onChange={e => handleMrpBrandNameChange(e.target.value)} disabled={!mrpBrandNumber} data-testid="inline-select-mrp-brand-name">
                <option value="">-- Select --</option>
                {uniqueBrandNames.map(bn => <option key={bn} value={bn}>{bn}</option>)}
              </select>
            </div>
            {/* Type */}
            <div className="flex flex-col gap-1 min-w-[110px] flex-1">
              <label className="text-xs font-medium text-muted-foreground">Type</label>
              <select className="input-field w-full text-sm" value={mrpProductType} onChange={e => handleMrpTypeChange(e.target.value)} disabled={!mrpBrandName} data-testid="inline-select-mrp-product-type">
                <option value="">-- Select --</option>
                {uniqueTypes.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            {/* Size */}
            <div className="flex flex-col gap-1 min-w-[100px] flex-1">
              <label className="text-xs font-medium text-muted-foreground">Size</label>
              <select className="input-field w-full text-sm" value={mrpSize} onChange={e => setMrpSize(e.target.value)} disabled={!mrpProductType} data-testid="inline-select-mrp-size">
                <option value="">-- Select --</option>
                {uniqueSizes.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {/* Sales MRP */}
            <div className="flex flex-col gap-1 min-w-[110px] flex-1">
              <label className="text-xs font-medium text-muted-foreground">Sales MRP (₹)</label>
              <input type="number" min="0" step="0.01" placeholder="e.g. 250" className="input-field text-right font-mono w-full text-sm" value={mrpValue} onChange={e => setMrpValue(e.target.value === "" ? "" : parseFloat(e.target.value))} data-testid="inline-input-mrp-value" />
            </div>
            {/* Save button */}
            <div className="flex flex-col gap-1 justify-end">
              <label className="text-xs font-medium text-muted-foreground invisible select-none">Save</label>
              <Button onClick={handleSaveMrp} disabled={isSavingMrp} data-testid="inline-button-save-mrp" className="whitespace-nowrap">
                {isSavingMrp ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Save className="w-4 h-4 mr-1.5" />}
                Save MRP
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-card border border-border rounded-xl p-4 flex items-start justify-between shadow-sm">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Total Revenue</p>
              <p className="text-2xl font-bold text-foreground">₹{salesStats.totalRevenue >= 100000 ? `${(salesStats.totalRevenue / 100000).toFixed(1)}L` : salesStats.totalRevenue >= 1000 ? `${(salesStats.totalRevenue / 1000).toFixed(1)}K` : salesStats.totalRevenue.toFixed(0)}</p>
            </div>
            <div className="p-2 bg-primary/5 rounded-lg"><TrendingUp className="w-5 h-5 text-primary" /></div>
          </div>
          <div className="bg-card border border-border rounded-xl p-4 flex items-start justify-between shadow-sm">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Bottles Sold</p>
              <p className="text-2xl font-bold text-foreground">{salesStats.bottlesSold.toLocaleString()}</p>
            </div>
            <div className="p-2 bg-blue-50 rounded-lg"><Package className="w-5 h-5 text-blue-600" /></div>
          </div>
          <div className="bg-card border border-border rounded-xl p-4 flex items-start justify-between shadow-sm">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Top Brand</p>
              <p className="text-xl font-bold text-foreground truncate max-w-[150px]" title={salesStats.topBrand}>{salesStats.topBrand}</p>
            </div>
            <div className="p-2 bg-yellow-50 rounded-lg"><Trophy className="w-5 h-5 text-yellow-600" /></div>
          </div>
          <div className="bg-card border border-border rounded-xl p-4 flex items-start justify-between shadow-sm">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Days Tracked</p>
              <p className="text-2xl font-bold text-foreground">{salesStats.daysTracked} <span className="text-base font-normal text-muted-foreground">days</span></p>
            </div>
            <div className="p-2 bg-green-50 rounded-lg"><CalendarIcon className="w-5 h-5 text-green-600" /></div>
          </div>
        </div>
      )}

      {/* ===================== MAIN PANEL ===================== */}
      <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">

        {/* TOOLBAR */}
        {activeView === 'invoices' && (
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border flex-wrap">
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search brands, SKUs..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                data-testid="input-search-orders"
                className="pl-8 pr-8 py-1.5 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 w-48 sm:w-64"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
              )}
            </div>

            {/* Filter */}
            <Popover open={filterOpen} onOpenChange={(v) => { if (v) openFilterPopover(); else setFilterOpen(false); }}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5" data-testid="button-filter">
                  <Filter className="w-3.5 h-3.5" /> Filter
                  {hasActiveFilters && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80 p-4" align="end">
                <h3 className="font-semibold text-foreground mb-3">Filters</h3>

                {/* Quick range */}
                <div className="mb-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2">Quick range</p>
                  <div className="flex flex-wrap gap-1.5">
                    {["Today", "Last 7 d", "Last 30 d", "This month", "This year"].map(label => (
                      <button
                        key={label}
                        onClick={() => applyQuickRange(label)}
                        className={cn("px-2.5 py-1 text-xs rounded-full border transition-colors", pendingQuick === label ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-muted")}
                        data-testid={`button-quick-range-${label.replace(/\s+/g, "-").toLowerCase()}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Date range */}
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">From</label>
                    <DatePickerInput
                      className="mt-1 w-full px-2 py-1.5 text-sm rounded-lg"
                      value={pendingFromDate ? format(pendingFromDate, "yyyy-MM-dd") : ""}
                      onChange={(val) => { setPendingFromDate(val ? parse(val, "yyyy-MM-dd", new Date()) : null); setPendingQuick(""); }}
                      placeholder="From date"
                      testId="input-filter-from-date"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">To</label>
                    <DatePickerInput
                      className="mt-1 w-full px-2 py-1.5 text-sm rounded-lg"
                      value={pendingToDate ? format(pendingToDate, "yyyy-MM-dd") : ""}
                      onChange={(val) => { setPendingToDate(val ? parse(val, "yyyy-MM-dd", new Date()) : null); setPendingQuick(""); }}
                      placeholder="To date"
                      testId="input-filter-to-date"
                    />
                  </div>
                </div>

                {/* ICDC */}
                <div className="mb-3">
                  <label className="text-xs font-medium text-muted-foreground">ICDC Number</label>
                  <input
                    type="text"
                    placeholder="e.g. ICDC0193..."
                    className="mt-1 block w-full border border-border rounded-lg px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                    value={pendingIcdc}
                    onChange={e => setPendingIcdc(e.target.value)}
                    data-testid="input-filter-icdc-number"
                  />
                </div>

                {/* Brand No */}
                <div className="mb-4">
                  <label className="text-xs font-medium text-muted-foreground">Brand No</label>
                  <input
                    type="text"
                    placeholder="e.g. 0019"
                    className="mt-1 block w-full border border-border rounded-lg px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                    value={pendingBrand}
                    onChange={e => setPendingBrand(e.target.value)}
                    data-testid="input-filter-brand-number"
                  />
                </div>

                <div className="flex gap-2">
                  <button onClick={resetFilters} className="flex-1 py-1.5 text-sm border border-border rounded-lg hover:bg-muted transition-colors" data-testid="button-reset-filters">Reset</button>
                  <button onClick={applyFilters} className="flex-1 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors font-medium" data-testid="button-apply-filters">Apply</button>
                </div>
              </PopoverContent>
            </Popover>

            {/* Sort */}
            <Popover open={sortOpen} onOpenChange={setSortOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5" data-testid="button-sort">
                  <ArrowUpDown className="w-3.5 h-3.5" /> Sort
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-3" align="end">
                <div className="space-y-3">
                  {[
                    { field: "invoiceDate" as SortField, label: "INVOICE DATE" },
                    { field: "brandNumber" as SortField, label: "BRAND NO" },
                    { field: "brandName" as SortField, label: "BRAND NAME" },
                    { field: "qtyCasesDelivered" as SortField, label: "CASES" },
                    { field: "ratePerCase" as SortField, label: "RATE / CASE" },
                  ].map(({ field, label }) => (
                    <div key={field}>
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 px-1">{label}</p>
                      <SortOption field={field} dir="asc" label="Ascending" activeSortField={sortField} activeSortDir={sortDir} onSort={handleSetSort} />
                      <SortOption field={field} dir="desc" label="Descending" activeSortField={sortField} activeSortDir={sortDir} onSort={handleSetSort} />
                    </div>
                  ))}
                </div>
              </PopoverContent>
            </Popover>

            {/* Import — admin only */}
            {isAdmin && (
              <div className="flex items-stretch">
                <Button
                  size="sm"
                  className="rounded-r-none gap-1.5 border-r-0"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading || isCheckingDuplicate}
                  data-testid="button-import-upload"
                >
                  {isUploading || isCheckingDuplicate ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}
                  PDF Import
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" className="rounded-l-none px-2" data-testid="button-import-dropdown">
                      <ChevronDown className="w-3.5 h-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => fileInputRef.current?.click()} data-testid="menu-import-excel">
                      <FileSpreadsheet className="w-4 h-4 mr-2" /> Import from Excel / CSV
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild data-testid="menu-download-template">
                      <a href="/api/template/download?format=xlsx" download="Invoice_Template.xlsx">
                        <Download className="w-4 h-4 mr-2" /> Download sample template
                      </a>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={handleExportOrders} disabled={displayOrders.length === 0} data-testid="menu-export-view">
                      <Download className="w-4 h-4 mr-2" /> Export current view ({displayOrders.length})
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}

            {/* Add Entry — admin only */}
            {isAdmin && (
              <Button size="sm" className="gap-1.5" onClick={() => setShowManualEntryDialog(true)} data-testid="button-add-entry">
                <Plus className="w-3.5 h-3.5" /> Add Entry
              </Button>
            )}

            {/* More options (Settings) */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="button-more-options">
                  <Settings2 className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {(dirtyOrderMap.size + pendingDeleteOrderIds.size) > 0 && (
                  <>
                    <DropdownMenuItem onClick={handleUpdateOrders} data-testid="menu-save-changes" className="text-primary font-medium">
                      <Save className="w-4 h-4 mr-2" />
                      Save changes ({dirtyOrderMap.size + pendingDeleteOrderIds.size})
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        )}

        {/* ======= INVOICES TAB CONTENT ======= */}
        {activeView === 'invoices' && (<>

        {/* Active filter chips */}
        {hasActiveFilters && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-border bg-muted/30">
            <span className="text-xs text-muted-foreground">Active:</span>
            {filterFromDate && <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary/10 text-primary text-xs rounded-full">From: {format(filterFromDate, "dd-MM-yyyy")}<button onClick={() => { setFilterFromDate(null); setQuickRange(""); }}><X className="w-3 h-3" /></button></span>}
            {filterToDate && <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary/10 text-primary text-xs rounded-full">To: {format(filterToDate, "dd-MM-yyyy")}<button onClick={() => { setFilterToDate(null); setQuickRange(""); }}><X className="w-3 h-3" /></button></span>}
            {filterIcdcNumber && <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary/10 text-primary text-xs rounded-full">ICDC: {filterIcdcNumber}<button onClick={() => setFilterIcdcNumber("")}><X className="w-3 h-3" /></button></span>}
            {filterBrandNumber && <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary/10 text-primary text-xs rounded-full">Brand: {filterBrandNumber}<button onClick={() => setFilterBrandNumber("")}><X className="w-3 h-3" /></button></span>}
            <button onClick={clearAllFilters} className="text-xs text-muted-foreground hover:text-destructive underline ml-auto">Clear all</button>
          </div>
        )}

        {/* Pending changes bar */}
        {(dirtyOrderMap.size + pendingDeleteOrderIds.size) > 0 && (
          <div className="flex items-center justify-between px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-xs">
            <span>{dirtyOrderMap.size + pendingDeleteOrderIds.size} unsaved change(s)</span>
            <div className="flex gap-2">
              <button onClick={() => { setDirtyOrderMap(new Map()); setPendingDeleteOrderIds(new Set()); }} className="underline hover:no-underline">Discard</button>
              <button onClick={handleUpdateOrders} disabled={isUpdatingOrders} className="font-semibold underline hover:no-underline flex items-center gap-1">
                {isUpdatingOrders && <Loader2 className="w-3 h-3 animate-spin" />} Save changes
              </button>
            </div>
          </div>
        )}

        {/* TABLE */}
        {isLoadingOrders ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : displayOrders.length > 0 ? (
          <>
            <div className="overflow-x-auto table-typography">
              <table className="w-full min-w-[900px]">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th className="table-header w-10 text-center">#</th>
                    <th className="table-header w-28 uppercase text-[10px] tracking-wider">
                      <button onClick={() => handleSetSort("invoiceDate", sortField === "invoiceDate" && sortDir === "asc" ? "desc" : "asc")} className="flex items-center gap-1 hover:text-foreground">
                        Invoice Date {sortField === "invoiceDate" ? (sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-40" />}
                      </button>
                    </th>
                    <th className="table-header w-40 uppercase text-[10px] tracking-wider">ICDC</th>
                    <th className="table-header w-20 uppercase text-[10px] tracking-wider">
                      <button onClick={() => handleSetSort("brandNumber", sortField === "brandNumber" && sortDir === "asc" ? "desc" : "asc")} className="flex items-center gap-1 hover:text-foreground">
                        Brand {sortField === "brandNumber" ? (sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-40" />}
                      </button>
                    </th>
                    <th className="table-header uppercase text-[10px] tracking-wider">
                      <button onClick={() => handleSetSort("brandName", sortField === "brandName" && sortDir === "asc" ? "desc" : "asc")} className="flex items-center gap-1 hover:text-foreground">
                        Name {sortField === "brandName" ? (sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-40" />}
                      </button>
                    </th>
                    <th className="table-header w-16 uppercase text-[10px] tracking-wider">Type</th>
                    <th className="table-header w-28 uppercase text-[10px] tracking-wider">Size</th>
                    <th className="table-header w-16 text-right uppercase text-[10px] tracking-wider">
                      <button onClick={() => handleSetSort("qtyCasesDelivered", sortField === "qtyCasesDelivered" && sortDir === "asc" ? "desc" : "asc")} className="flex items-center gap-1 ml-auto hover:text-foreground">
                        Cases {sortField === "qtyCasesDelivered" ? (sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-40" />}
                      </button>
                    </th>
                    <th className="table-header w-16 text-right uppercase text-[10px] tracking-wider">Bottles</th>
                    <th className="table-header w-24 text-right uppercase text-[10px] tracking-wider">
                      <button onClick={() => handleSetSort("ratePerCase", sortField === "ratePerCase" && sortDir === "asc" ? "desc" : "asc")} className="flex items-center gap-1 ml-auto hover:text-foreground">
                        Rate/Case {sortField === "ratePerCase" ? (sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-40" />}
                      </button>
                    </th>
                    <th className="table-header w-20 text-right uppercase text-[10px] tracking-wider">Rate/Btl</th>
                    {isAdmin && <th className="table-header w-20 text-center uppercase text-[10px] tracking-wider">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {paginatedDisplay.map((order: Order, idx: number) => {
                    const globalIdx = (savedPage - 1) * savedPageSize + idx;
                    const isEditing = editingOrderId === order.id;
                    const isDirty = dirtyOrderMap.has(order.id);
                    const isDeleteConfirm = deleteConfirmOrderId === order.id;
                    return (
                      <tr
                        key={order.id}
                        className={cn("border-b border-border/50 transition-colors", isEditing ? "bg-amber-50/60 dark:bg-amber-900/10" : isDirty ? "bg-blue-50/40 dark:bg-blue-900/10" : "hover:bg-muted/30")}
                        data-testid={`row-saved-order-${globalIdx}`}
                      >
                        <td className="table-cell text-muted-foreground text-center text-xs">{globalIdx + 1}</td>
                        <td className="table-cell text-sm">
                          {isEditing ? <DatePickerInput className="w-32" value={editOrderData.invoiceDate ?? ""} onChange={(val) => handleOrderEditField("invoiceDate", val)} /> : (formatDMY(order.invoiceDate) || "-")}
                        </td>
                        <td className="table-cell text-xs font-mono">
                          {isEditing ? <input className="input-field w-36 text-xs" value={editOrderData.icdcNumber ?? ""} onChange={e => handleOrderEditField("icdcNumber", e.target.value)} /> :
                            order.icdcNumber ? <button onClick={() => handleViewShopDetail(order.icdcNumber!)} className="text-primary underline hover:text-primary/80 cursor-pointer truncate max-w-[10rem] block" data-testid={`link-shop-detail-${globalIdx}`}>{order.icdcNumber}</button> : "-"
                          }
                        </td>
                        <td className="table-cell font-mono text-xs">
                          {isEditing ? <input className="input-field w-16 text-xs" value={editOrderData.brandNumber ?? ""} onChange={e => handleOrderEditField("brandNumber", e.target.value)} /> : order.brandNumber}
                        </td>
                        <td className="table-cell text-sm max-w-[160px]">
                          {isEditing ? <input className="input-field w-32 text-xs" value={editOrderData.brandName ?? ""} onChange={e => handleOrderEditField("brandName", e.target.value)} /> : <span className="truncate block">{order.brandName}</span>}
                        </td>
                        <td className="table-cell text-sm text-muted-foreground">
                          {isEditing ? <input className="input-field w-14 text-xs" value={editOrderData.productType ?? ""} onChange={e => handleOrderEditField("productType", e.target.value)} /> : order.productType}
                        </td>
                        <td className="table-cell text-xs text-muted-foreground">
                          {isEditing ? <input className="input-field w-24 text-xs" value={editOrderData.packSize ?? ""} onChange={e => handleOrderEditField("packSize", e.target.value)} /> : order.packSize}
                        </td>
                        <td className="table-cell text-right font-mono text-sm font-medium">
                          {isEditing ? <input type="number" className="input-field w-14 text-xs text-right" value={editOrderData.qtyCasesDelivered ?? 0} onChange={e => handleOrderEditField("qtyCasesDelivered", parseInt(e.target.value) || 0)} /> : order.qtyCasesDelivered}
                        </td>
                        <td className="table-cell text-right font-mono text-sm text-muted-foreground">
                          {isEditing ? <input type="number" className="input-field w-14 text-xs text-right" value={editOrderData.qtyBottlesDelivered ?? 0} onChange={e => handleOrderEditField("qtyBottlesDelivered", parseInt(e.target.value) || 0)} /> : order.qtyBottlesDelivered}
                        </td>
                        <td className="table-cell text-right font-mono text-sm">
                          {isEditing ? <input className="input-field w-20 text-xs text-right" value={editOrderData.ratePerCase ?? ""} onChange={e => handleOrderEditField("ratePerCase", e.target.value)} /> : fmt2(order.ratePerCase)}
                        </td>
                        <td className="table-cell text-right font-mono text-sm text-muted-foreground">
                          {isEditing ? <input className="input-field w-20 text-xs text-right" value={editOrderData.unitRatePerBottle ?? ""} onChange={e => handleOrderEditField("unitRatePerBottle", e.target.value)} /> : fmt2(order.unitRatePerBottle)}
                        </td>
                        {isAdmin && (
                          <td className="table-cell text-center">
                            {isEditing ? (
                              <div className="flex items-center justify-center gap-1">
                                <button onClick={handleOrderEditSave} className="p-1 rounded text-green-600 hover:bg-green-100" title="Save" data-testid={`btn-save-order-edit-${order.id}`}><Check className="w-4 h-4" /></button>
                                <button onClick={handleOrderEditCancel} className="p-1 rounded text-muted-foreground hover:bg-muted" title="Cancel" data-testid={`btn-cancel-order-edit-${order.id}`}><X className="w-4 h-4" /></button>
                              </div>
                            ) : isDeleteConfirm ? (
                              <div className="flex items-center justify-center gap-1">
                                <span className="text-xs text-red-600 font-medium mr-1">Sure?</span>
                                <button onClick={() => handleOrderDeleteConfirm(order.id)} className="p-1 rounded text-red-600 hover:bg-red-100" data-testid={`btn-confirm-delete-order-${order.id}`}><Check className="w-4 h-4" /></button>
                                <button onClick={() => setDeleteConfirmOrderId(null)} className="p-1 rounded text-muted-foreground hover:bg-muted" data-testid={`btn-cancel-delete-order-${order.id}`}><X className="w-4 h-4" /></button>
                              </div>
                            ) : (
                              <div className="flex items-center justify-center gap-1">
                                <button onClick={() => handleOrderEditStart(order)} className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10" title="Edit" data-testid={`btn-edit-order-${order.id}`}><Pencil className="w-3.5 h-3.5" /></button>
                                <button onClick={() => setDeleteConfirmOrderId(order.id)} className="p-1 rounded text-muted-foreground hover:text-red-600 hover:bg-red-50" title="Delete" data-testid={`btn-delete-order-${order.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <PaginationCustom
              currentPage={savedPage}
              totalPages={Math.ceil(displayOrders.length / savedPageSize)}
              pageSize={savedPageSize}
              onPageChange={setSavedPage}
              onPageSizeChange={(s) => { setSavedPageSize(s); setSavedPage(1); }}
              totalItems={displayOrders.length}
            />
          </>
        ) : (
          /* EMPTY STATE */
          <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
            <div className="w-14 h-14 rounded-full bg-muted/60 flex items-center justify-center mb-4">
              <ReceiptText className="w-7 h-7 text-muted-foreground/50" />
            </div>
            <h3 className="font-semibold text-foreground mb-1">No invoices yet</h3>
            <p className="text-sm text-muted-foreground max-w-sm mb-6">
              {hasActiveFilters || searchQuery ? "No invoices match your filters. Try clearing them." : "Upload an ICDC Excel/CSV to bring in many rows at once, or add a single line manually."}
            </p>
            {hasActiveFilters || searchQuery ? (
              <Button variant="outline" onClick={() => { clearAllFilters(); setSearchQuery(""); }}>Clear filters</Button>
            ) : isAdmin ? (
              <div className="flex gap-3">
                <Button onClick={() => fileInputRef.current?.click()} className="gap-2" data-testid="button-empty-import">
                  <UploadCloud className="w-4 h-4" /> Import ICDC file
                </Button>
                <Button variant="outline" onClick={() => setShowManualEntryDialog(true)} className="gap-2" data-testid="button-empty-add-manually">
                  <Plus className="w-4 h-4" /> Add manually
                </Button>
              </div>
            ) : null}
          </div>
        )}

        </>)} {/* end invoices tab */}

        {/* ======= UPDATE SALES MRP TAB CONTENT ======= */}
        {activeView === 'mrp' && (
          <>
            {/* Hidden MRP file input */}
            <input ref={mrpFileInputRef} type="file" accept=".xls,.xlsx,.csv" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) { setMrpUploadFile(f); } }} data-testid="input-mrp-file-upload" />

            {/* MRP Toolbar */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border flex-wrap">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">Sales MRP</span>
                <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded-full font-medium" data-testid="text-mrp-count">{salesMrpData?.length ?? 0}</span>
                <span className="text-xs text-muted-foreground">Updated just now</span>
              </div>
              <div className="ml-auto flex items-center gap-2 flex-wrap">
                {/* Search */}
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Search brands…"
                    value={mrpSearch}
                    onChange={e => setMrpSearch(e.target.value)}
                    data-testid="input-mrp-search"
                    className="pl-8 pr-8 py-1.5 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 w-48"
                  />
                  {mrpSearch && (
                    <button onClick={() => setMrpSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
                  )}
                </div>

                {/* Filter */}
                <Popover open={mrpFilterOpen} onOpenChange={v => { if (v) handleMrpOpenFilter(); else setMrpFilterOpen(false); }}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-1.5" data-testid="button-mrp-filter">
                      <Filter className="w-3.5 h-3.5" /> Filter
                      {hasMrpActiveFilters && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-72 p-4" align="end">
                    <h3 className="font-semibold text-foreground mb-3">Filters</h3>
                    <div className="mb-3">
                      <label className="text-xs font-medium text-muted-foreground">Brand No</label>
                      <Popover open={mrpFilterBrandNoComboOpen} onOpenChange={setMrpFilterBrandNoComboOpen}>
                        <PopoverTrigger asChild>
                          <button
                            data-testid="combobox-mrp-filter-brand-no"
                            className="mt-1 flex items-center justify-between w-full border border-border rounded-lg px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 text-left"
                            role="combobox"
                          >
                            <span className={mrpPendingBrandNo ? "text-foreground" : "text-muted-foreground"}>
                              {mrpPendingBrandNo || "All brand numbers"}
                            </span>
                            <ChevronsUpDown className="w-3.5 h-3.5 shrink-0 opacity-50" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[220px] p-0" align="start">
                          <Command>
                            <CommandInput placeholder="Search brand no..." />
                            <CommandList>
                              <CommandEmpty>No brand no found.</CommandEmpty>
                              <CommandGroup>
                                {mrpPendingBrandNo && (
                                  <CommandItem value="__clear__" onSelect={() => { setMrpPendingBrandNo(''); setMrpFilterBrandNoComboOpen(false); }}>
                                    <X className="mr-2 h-4 w-4 text-muted-foreground" /> Clear
                                  </CommandItem>
                                )}
                                {uniqueFilterMrpBrandNos.map(bn => (
                                  <CommandItem
                                    key={bn}
                                    value={bn}
                                    onSelect={val => {
                                      const original = uniqueFilterMrpBrandNos.find(n => n.toLowerCase() === val.toLowerCase()) ?? val;
                                      setMrpPendingBrandNo(original === mrpPendingBrandNo ? '' : original);
                                      setMrpFilterBrandNoComboOpen(false);
                                    }}
                                  >
                                    <Check className={cn("mr-2 h-4 w-4", mrpPendingBrandNo === bn ? "opacity-100" : "opacity-0")} />
                                    {bn}
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    </div>
                    <div className="mb-4">
                      <label className="text-xs font-medium text-muted-foreground">Product Description</label>
                      <Popover open={mrpFilterDescComboOpen} onOpenChange={setMrpFilterDescComboOpen}>
                        <PopoverTrigger asChild>
                          <button
                            data-testid="combobox-mrp-filter-product-desc"
                            className="mt-1 flex items-center justify-between w-full border border-border rounded-lg px-3 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 text-left"
                            role="combobox"
                          >
                            <span className={mrpPendingBrandName ? "text-foreground" : "text-muted-foreground"}>
                              {mrpPendingBrandName || "All descriptions"}
                            </span>
                            <ChevronsUpDown className="w-3.5 h-3.5 shrink-0 opacity-50" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[220px] p-0" align="start">
                          <Command>
                            <CommandInput placeholder="Search description..." />
                            <CommandList>
                              <CommandEmpty>No description found.</CommandEmpty>
                              <CommandGroup>
                                {mrpPendingBrandName && (
                                  <CommandItem value="__clear__" onSelect={() => { setMrpPendingBrandName(''); setMrpFilterDescComboOpen(false); }}>
                                    <X className="mr-2 h-4 w-4 text-muted-foreground" /> Clear
                                  </CommandItem>
                                )}
                                {uniqueFilterMrpBrandNames.map(bn => (
                                  <CommandItem
                                    key={bn}
                                    value={bn}
                                    onSelect={val => {
                                      const original = uniqueFilterMrpBrandNames.find(n => n.toLowerCase() === val.toLowerCase()) ?? val;
                                      setMrpPendingBrandName(original === mrpPendingBrandName ? '' : original);
                                      setMrpFilterDescComboOpen(false);
                                    }}
                                  >
                                    <Check className={cn("mr-2 h-4 w-4", mrpPendingBrandName === bn ? "opacity-100" : "opacity-0")} />
                                    {bn}
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={handleMrpResetFilter} className="flex-1 py-1.5 text-sm border border-border rounded-lg hover:bg-muted transition-colors" data-testid="button-mrp-reset-filters">Reset</button>
                      <button onClick={handleMrpApplyFilter} className="flex-1 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors font-medium" data-testid="button-mrp-apply-filters">Apply</button>
                    </div>
                  </PopoverContent>
                </Popover>

                {/* Sort */}
                <Popover open={mrpSortOpen} onOpenChange={setMrpSortOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-1.5" data-testid="button-mrp-sort">
                      <ArrowUpDown className="w-3.5 h-3.5" /> Sort
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-56 p-3" align="end">
                    <div className="space-y-3">
                      {([
                        { field: 'brandNumber' as const, label: 'BRAND NO' },
                        { field: 'brandName' as const, label: 'BRAND NAME' },
                        { field: 'productType' as const, label: 'TYPE' },
                        { field: 'size' as const, label: 'SIZE' },
                        { field: 'salesMrp' as const, label: 'MRP (₹)' },
                      ]).map(({ field, label }) => (
                        <div key={field}>
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 px-1">{label}</p>
                          <button
                            onClick={() => handleMrpSetSort(field, 'asc')}
                            className={cn("flex items-center gap-2 w-full px-3 py-1.5 text-sm rounded-md transition-colors", mrpSortField === field && mrpSortDir === 'asc' ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted text-foreground")}
                          >
                            <ArrowUp className="w-3.5 h-3.5" /> Ascending
                            {mrpSortField === field && mrpSortDir === 'asc' && <Check className="w-3.5 h-3.5 ml-auto" />}
                          </button>
                          <button
                            onClick={() => handleMrpSetSort(field, 'desc')}
                            className={cn("flex items-center gap-2 w-full px-3 py-1.5 text-sm rounded-md transition-colors", mrpSortField === field && mrpSortDir === 'desc' ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted text-foreground")}
                          >
                            <ArrowDown className="w-3.5 h-3.5" /> Descending
                            {mrpSortField === field && mrpSortDir === 'desc' && <Check className="w-3.5 h-3.5 ml-auto" />}
                          </button>
                        </div>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>

                {/* Import + dropdown */}
                <div className="flex items-stretch">
                  <Button
                    size="sm"
                    className="rounded-r-none gap-1.5 border-r-0"
                    onClick={() => mrpFileInputRef.current?.click()}
                    disabled={isMrpUploading}
                    data-testid="button-mrp-import"
                  >
                    {isMrpUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}
                    Import
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" className="rounded-l-none px-2" data-testid="button-mrp-import-dropdown">
                        <ChevronDown className="w-3.5 h-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => mrpFileInputRef.current?.click()} data-testid="menu-mrp-import-excel">
                        <FileSpreadsheet className="w-4 h-4 mr-2" /> Import from Excel / CSV
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => { window.location.href = "/api/mrp-template/download"; }}
                        data-testid="menu-mrp-download-template"
                      >
                        <Download className="w-4 h-4 mr-2" /> Download sample template
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {/* Export */}
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => {
                    const rows = displayMrpRecords.map(r => ({
                      brand_number: r.brandNumber,
                      brand_name: r.brandName,
                      product_type: r.productType ?? "",
                      size: r.size,
                      sales_mrp: r.salesMrp,
                    }));
                    const ws = XLSX.utils.json_to_sheet(rows);
                    const wb = XLSX.utils.book_new();
                    XLSX.utils.book_append_sheet(wb, ws, "Sales MRP");
                    XLSX.writeFile(wb, `Sales_MRP_Export_${new Date().toISOString().slice(0,10)}.xlsx`);
                  }}
                  data-testid="button-mrp-export"
                >
                  <Download className="w-3.5 h-3.5" /> Export
                </Button>
              </div>
            </div>

            {/* MRP upload pending file bar */}
            {mrpUploadFile && (
              <div className="flex items-center gap-3 px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-xs">
                <FileSpreadsheet className="w-4 h-4 shrink-0" />
                <span className="flex-1 truncate font-medium">{mrpUploadFile.name}</span>
                <Button onClick={handleMrpBulkUpload} disabled={isMrpUploading} size="sm" data-testid="button-mrp-upload-import">
                  {isMrpUploading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
                  {isMrpUploading ? "Importing…" : "Import & Save"}
                </Button>
                <button onClick={() => { setMrpUploadFile(null); if (mrpFileInputRef.current) mrpFileInputRef.current.value = ""; }} className="p-1 text-amber-600 hover:text-destructive"><X className="w-4 h-4" /></button>
              </div>
            )}

            {/* Bulk action toolbar */}
            {mrpSelectedIds.size > 0 && (
              <div className="flex items-center gap-3 px-4 py-2.5 bg-primary/5 border-b border-border">
                <span className="text-sm font-medium text-foreground" data-testid="text-mrp-selected-count">
                  {mrpSelectedIds.size} selected
                </span>
                <Button
                  size="sm"
                  variant="destructive"
                  className="gap-1.5 h-7 text-xs"
                  onClick={handleBulkDeleteMrp}
                  disabled={isBulkDeletingMrp}
                  data-testid="button-mrp-bulk-delete"
                >
                  {isBulkDeletingMrp ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  Delete {mrpSelectedIds.size} selected
                </Button>
                <button
                  onClick={() => setMrpSelectedIds(new Set())}
                  className="text-xs text-muted-foreground hover:text-foreground"
                  data-testid="button-mrp-clear-selection"
                >
                  Clear selection
                </button>
              </div>
            )}

            {/* MRP Table / Empty state */}
            {isLoadingMrp ? (
              <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
            ) : displayMrpRecords.length > 0 ? (
              <>
              <div className="overflow-x-auto table-typography">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      <th className="w-10 px-3 py-2.5">
                        <Checkbox
                          checked={someVisibleMrpSelected ? "indeterminate" : allVisibleMrpSelected}
                          onCheckedChange={toggleMrpSelectAll}
                          data-testid="checkbox-mrp-select-all"
                          aria-label="Select all MRP rows"
                        />
                      </th>
                      <th className="table-header w-10 text-center uppercase text-[10px] tracking-wider">#</th>
                      <th className="table-header w-24 uppercase text-[10px] tracking-wider">
                        <button onClick={() => handleMrpSetSort('brandNumber', mrpSortField === 'brandNumber' && mrpSortDir === 'asc' ? 'desc' : 'asc')} className="flex items-center gap-1 hover:text-foreground">
                          BRAND {mrpSortField === 'brandNumber' ? (mrpSortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-40" />}
                        </button>
                      </th>
                      <th className="table-header uppercase text-[10px] tracking-wider">
                        <button onClick={() => handleMrpSetSort('brandName', mrpSortField === 'brandName' && mrpSortDir === 'asc' ? 'desc' : 'asc')} className="flex items-center gap-1 hover:text-foreground">
                          NAME {mrpSortField === 'brandName' ? (mrpSortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-40" />}
                        </button>
                      </th>
                      <th className="table-header w-20 uppercase text-[10px] tracking-wider">
                        <button onClick={() => handleMrpSetSort('productType', mrpSortField === 'productType' && mrpSortDir === 'asc' ? 'desc' : 'asc')} className="flex items-center gap-1 hover:text-foreground">
                          TYPE {mrpSortField === 'productType' ? (mrpSortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-40" />}
                        </button>
                      </th>
                      <th className="table-header w-28 uppercase text-[10px] tracking-wider">
                        <button onClick={() => handleMrpSetSort('size', mrpSortField === 'size' && mrpSortDir === 'asc' ? 'desc' : 'asc')} className="flex items-center gap-1 hover:text-foreground">
                          SIZE {mrpSortField === 'size' ? (mrpSortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-40" />}
                        </button>
                      </th>
                      <th className="table-header w-28 text-right uppercase text-[10px] tracking-wider text-primary bg-primary/5">
                        <button onClick={() => handleMrpSetSort('salesMrp', mrpSortField === 'salesMrp' && mrpSortDir === 'asc' ? 'desc' : 'asc')} className="flex items-center gap-1 ml-auto hover:text-primary/80">
                          MRP (₹) {mrpSortField === 'salesMrp' ? (mrpSortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-40" />}
                        </button>
                      </th>
                      <th className="table-header w-16 text-center uppercase text-[10px] tracking-wider">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedMrpRecords.map((row, idx) => (
                      <tr key={row.id} className={`border-b border-border/50 hover:bg-muted/30 transition-colors ${mrpSelectedIds.has(row.id) ? "bg-primary/5" : ""}`} data-testid={`row-sales-mrp-${row.id}`}>
                        <td className="px-3 py-2.5">
                          <Checkbox
                            checked={mrpSelectedIds.has(row.id)}
                            onCheckedChange={() => toggleMrpRow(row.id)}
                            data-testid={`checkbox-mrp-row-${row.id}`}
                            aria-label={`Select MRP row ${row.id}`}
                          />
                        </td>
                        <td className="table-cell text-center text-xs text-muted-foreground">{mrpPageStart + idx + 1}</td>
                        <td className="table-cell font-mono text-xs text-muted-foreground">{row.brandNumber}</td>
                        <td className="table-cell font-medium">{row.brandName}</td>
                        <td className="table-cell text-muted-foreground">{row.productType}</td>
                        <td className="table-cell text-muted-foreground text-xs">{row.size}</td>
                        <td className="table-cell text-right font-bold text-primary font-mono bg-primary/5">₹{row.salesMrp}</td>
                        <td className="table-cell text-center">
                          <div className="flex items-center justify-center gap-1">
                            <button onClick={() => handleLoadMrpEdit(row)} className="p-1.5 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-lg" data-testid={`button-edit-mrp-${row.id}`} title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                            <button onClick={() => handleDeleteMrp(row.id)} disabled={isDeletingMrp} className="p-1.5 text-destructive/60 hover:text-destructive hover:bg-destructive/10 rounded-lg disabled:opacity-50" data-testid={`button-delete-mrp-${row.id}`} title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Pagination */}
              <div className="flex items-center justify-between px-3 py-2.5 border-t border-border bg-muted/20">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>Rows per page:</span>
                  <div className="flex items-center gap-1">
                    {[15, 20, 25].map(n => (
                      <button
                        key={n}
                        onClick={() => { setMrpRowsPerPage(n); setMrpCurrentPage(1); }}
                        className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors ${mrpRowsPerPage === n ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-muted"}`}
                        data-testid={`button-mrp-rows-${n}`}
                      >{n}</button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-1 text-sm text-muted-foreground">
                  <span className="mr-2">
                    {displayMrpRecords.length === 0 ? "0" : `${mrpPageStart + 1}–${Math.min(mrpPageStart + mrpRowsPerPage, displayMrpRecords.length)}`} of {displayMrpRecords.length}
                  </span>
                  <button onClick={() => setMrpCurrentPage(1)} disabled={mrpCurrentPage === 1} className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed" data-testid="button-mrp-first-page" title="First page"><ChevronsLeft className="w-4 h-4" /></button>
                  <button onClick={() => setMrpCurrentPage(p => Math.max(1, p - 1))} disabled={mrpCurrentPage === 1} className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed" data-testid="button-mrp-prev-page" title="Previous page"><ChevronLeft className="w-4 h-4" /></button>
                  {Array.from({ length: mrpTotalPages }, (_, i) => i + 1).filter(p => p === 1 || p === mrpTotalPages || Math.abs(p - mrpCurrentPage) <= 1).reduce<(number | string)[]>((acc, p, i, arr) => {
                    if (i > 0 && (p as number) - (arr[i - 1] as number) > 1) acc.push("...");
                    acc.push(p);
                    return acc;
                  }, []).map((p, i) => p === "..." ? (
                    <span key={`ellipsis-${i}`} className="px-1 text-xs text-muted-foreground">…</span>
                  ) : (
                    <button key={p} onClick={() => setMrpCurrentPage(p as number)} className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${mrpCurrentPage === p ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`} data-testid={`button-mrp-page-${p}`}>{p}</button>
                  ))}
                  <button onClick={() => setMrpCurrentPage(p => Math.min(mrpTotalPages, p + 1))} disabled={mrpCurrentPage === mrpTotalPages} className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed" data-testid="button-mrp-next-page" title="Next page"><ChevronRight className="w-4 h-4" /></button>
                  <button onClick={() => setMrpCurrentPage(mrpTotalPages)} disabled={mrpCurrentPage === mrpTotalPages} className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed" data-testid="button-mrp-last-page" title="Last page"><ChevronsRight className="w-4 h-4" /></button>
                </div>
              </div>
              </>
            ) : (
              /* MRP Empty State */
              <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
                <div className="w-14 h-14 rounded-full bg-muted/60 flex items-center justify-center mb-4">
                  <Tag className="w-7 h-7 text-muted-foreground/50" />
                </div>
                <h3 className="font-semibold text-foreground mb-1">No MRP records yet</h3>
                <p className="text-sm text-muted-foreground max-w-sm mb-6">
                  Import an Excel of brand-wise state-fixed MRPs, or add one manually.
                </p>
                <div className="flex gap-3">
                  <Button onClick={() => mrpFileInputRef.current?.click()} className="gap-2" data-testid="button-mrp-empty-import">
                    <UploadCloud className="w-4 h-4" /> Import MRP file
                  </Button>
                  <Button variant="outline" onClick={() => { setMrpEditId(null); setMrpBrandNumber(""); setMrpBrandName(""); setMrpProductType(""); setMrpSize(""); setMrpValue(""); setShowMrpFormDialog(true); }} className="gap-2" data-testid="button-mrp-empty-add">
                    <Plus className="w-4 h-4" /> Add manually
                  </Button>
                </div>
                {(mrpSearch || hasMrpActiveFilters) && (
                  <button onClick={() => { setMrpSearch(""); setMrpFilterBrandNo(""); setMrpFilterBrandName(""); }} className="mt-4 text-xs text-muted-foreground hover:text-foreground underline">
                    Clear search & filters
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {/* MRP Add/Edit Dialog */}
        <Dialog open={showMrpFormDialog} onOpenChange={open => { if (!open) { setMrpEditId(null); setMrpBrandNumber(""); setMrpBrandName(""); setMrpProductType(""); setMrpSize(""); setMrpValue(""); } setShowMrpFormDialog(open); }}>
          <DialogContent className="max-w-[95vw] w-full" style={{ maxWidth: "900px" }}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Tag className="w-4 h-4 text-primary" />
                {mrpEditId ? "Edit Sales MRP" : "Add Sales MRP"}
              </DialogTitle>
              <DialogDescription>
                {mrpEditId ? "Update the MRP for this brand entry." : "Select brand details and enter the Sales MRP."}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap gap-3 py-2 items-end">
              {/* Brand No */}
              <div className="flex flex-col gap-1.5 min-w-[130px] flex-1">
                <label className="text-xs font-medium text-muted-foreground">Brand No</label>
                <Popover open={brandNoComboOpen} onOpenChange={setBrandNoComboOpen}>
                  <PopoverTrigger asChild>
                    <button data-testid="select-mrp-brand-number" className="input-field flex items-center justify-between text-left w-full" role="combobox">
                      <span className={mrpBrandNumber ? "text-foreground" : "text-muted-foreground"}>{mrpBrandNumber || "-- Select --"}</span>
                      <ChevronsUpDown className="w-4 h-4 shrink-0 opacity-50 ml-1" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[200px] p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search brand no..." />
                      <CommandList>
                        <CommandEmpty>No brand found.</CommandEmpty>
                        <CommandGroup>
                          {uniqueBrandNumbers.map(bn => (
                            <CommandItem key={bn} value={bn} onSelect={val => { const original = uniqueBrandNumbers.find(n => n.toLowerCase() === val.toLowerCase()) ?? val; handleMrpBrandNumberChange(original === mrpBrandNumber ? "" : original); setBrandNoComboOpen(false); }}>
                              <Check className={cn("mr-2 h-4 w-4", mrpBrandNumber === bn ? "opacity-100" : "opacity-0")} />{bn}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
              {/* Brand Name */}
              <div className="flex flex-col gap-1.5 min-w-[160px] flex-[2]">
                <label className="text-xs font-medium text-muted-foreground">Brand Name</label>
                <select className="input-field w-full" value={mrpBrandName} onChange={e => handleMrpBrandNameChange(e.target.value)} disabled={!mrpBrandNumber} data-testid="select-mrp-brand-name">
                  <option value="">-- Select --</option>
                  {uniqueBrandNames.map(bn => <option key={bn} value={bn}>{bn}</option>)}
                </select>
              </div>
              {/* Type */}
              <div className="flex flex-col gap-1.5 min-w-[120px] flex-1">
                <label className="text-xs font-medium text-muted-foreground">Type</label>
                <select className="input-field w-full" value={mrpProductType} onChange={e => handleMrpTypeChange(e.target.value)} disabled={!mrpBrandName} data-testid="select-mrp-product-type">
                  <option value="">-- Select --</option>
                  {uniqueTypes.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              {/* Size */}
              <div className="flex flex-col gap-1.5 min-w-[110px] flex-1">
                <label className="text-xs font-medium text-muted-foreground">Size</label>
                <select className="input-field w-full" value={mrpSize} onChange={e => setMrpSize(e.target.value)} disabled={!mrpProductType} data-testid="select-mrp-size">
                  <option value="">-- Select --</option>
                  {uniqueSizes.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              {/* Sales MRP */}
              <div className="flex flex-col gap-1.5 min-w-[110px] flex-1">
                <label className="text-xs font-medium text-muted-foreground">Sales MRP (₹)</label>
                <input type="number" min="0" step="0.01" placeholder="e.g. 250" className="input-field text-right font-mono w-full" value={mrpValue} onChange={e => setMrpValue(e.target.value === "" ? "" : parseFloat(e.target.value))} data-testid="input-mrp-value" />
              </div>
              {/* Save button inline */}
              <div className="flex flex-col gap-1.5 justify-end">
                <label className="text-xs font-medium text-muted-foreground invisible">Save</label>
                <Button onClick={handleSaveMrp} disabled={isSavingMrp} data-testid="button-save-sales-mrp" className="whitespace-nowrap">
                  {isSavingMrp ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                  {mrpEditId ? "Update MRP" : "Save MRP"}
                </Button>
              </div>
            </div>
            <DialogFooter className="gap-2 pt-0">
              <Button variant="outline" onClick={() => setShowMrpFormDialog(false)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ======= SALES RECORDS TAB CONTENT ======= */}
        {activeView === 'import-sales' && (
          <div>
            {/* Sales Records Toolbar */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border flex-wrap">
              <span className="text-sm font-medium text-foreground">
                Sales Records <span className="text-muted-foreground font-normal">{displaySales.length}</span>
              </span>
              <div className="ml-auto flex items-center gap-2 flex-wrap">
                {/* Search */}
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Search brand, date..."
                    value={srSearchQuery}
                    onChange={e => { setSrSearchQuery(e.target.value); setSrPage(1); }}
                    data-testid="input-search-sales-records"
                    className="pl-8 pr-8 py-1.5 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 w-48 sm:w-56"
                  />
                  {srSearchQuery && (
                    <button onClick={() => setSrSearchQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
                  )}
                </div>

                {/* Sort */}
                <Popover open={srSortOpen} onOpenChange={setSrSortOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-1.5" data-testid="button-sort-sales-records">
                      <ArrowUpDown className="w-3.5 h-3.5" />
                      Sort
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-56 p-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase px-2 mb-1">Sort by</p>
                    {([
                      ['saleDate', 'Sale Date'],
                      ['brandNumber', 'Brand No'],
                      ['brandName', 'Brand Name'],
                      ['soldBottles', 'Sold Bottles'],
                      ['saleValue', 'Amount'],
                    ] as const).map(([field, label]) => (
                      <button
                        key={field}
                        onClick={() => {
                          if (srSortField === field) setSrSortDir(d => d === 'asc' ? 'desc' : 'asc');
                          else { setSrSortField(field); setSrSortDir('asc'); }
                          setSrSortOpen(false);
                        }}
                        className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-sm hover:bg-muted ${srSortField === field ? 'text-primary font-medium' : ''}`}
                      >
                        {label}
                        {srSortField === field && <span className="text-xs">{srSortDir === 'asc' ? '↑' : '↓'}</span>}
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>

                {/* Import dropdown */}
                {user?.role === 'admin' && (
                  <>
                    <input
                      ref={srFileInputRef}
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      className="hidden"
                      onChange={e => { const f = e.target.files?.[0]; if (f) handleSrImport(f); }}
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" className="gap-1.5" data-testid="button-sr-import">
                          <Upload className="w-3.5 h-3.5" />
                          Import
                          <ChevronDown className="w-3 h-3 ml-0.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuItem onClick={() => srFileInputRef.current?.click()} data-testid="dropdown-sr-import-file">
                          <Upload className="w-4 h-4 mr-2" /> Import from Excel / CSV
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <a href="/sales_import_template.xlsx" download data-testid="dropdown-sr-template">
                            <FileSpreadsheet className="w-4 h-4 mr-2" /> Download sample template
                          </a>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          data-testid="dropdown-sr-export"
                          onClick={() => {
                            const rows = displaySales;
                            const header = ['Sale Date', 'Brand No', 'Brand Name', 'Size', 'Qty/Cs', 'Sold Btls', 'Amount'];
                            const csv = [header, ...rows.map(r => [r.saleDate, r.brandNumber, r.brandName, r.size, r.quantityPerCase, r.soldBottles, r.totalSaleValue ?? r.saleValue])].map(row => row.join(',')).join('\n');
                            const blob = new Blob([csv], { type: 'text/csv' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a'); a.href = url; a.download = 'sales_records.csv'; a.click();
                            URL.revokeObjectURL(url);
                          }}
                        >
                          <FileText className="w-4 h-4 mr-2" /> Export current view ({displaySales.length})
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}

                {/* Refresh */}
                <Button variant="ghost" size="sm" onClick={() => refetchSales()} data-testid="button-sr-refresh" className="gap-1.5">
                  <RefreshCw className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>

            {/* Bulk action toolbar */}
            {srSelectedIds.size > 0 && (
              <div className="flex items-center gap-3 px-4 py-2.5 bg-primary/5 border-b border-border">
                <span className="text-sm font-medium text-foreground" data-testid="text-sr-selected-count">
                  {srSelectedIds.size} selected
                </span>
                <Button
                  size="sm"
                  variant="destructive"
                  className="gap-1.5 h-7 text-xs"
                  onClick={handleBulkDeleteSr}
                  disabled={isBulkDeletingSr}
                  data-testid="button-sr-bulk-delete"
                >
                  {isBulkDeletingSr ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  Delete {srSelectedIds.size} selected
                </Button>
                <button
                  onClick={() => setSrSelectedIds(new Set())}
                  className="text-xs text-muted-foreground hover:text-foreground"
                  data-testid="button-sr-clear-selection"
                >
                  Clear selection
                </button>
              </div>
            )}

            {/* Sales Records Table */}
            {isLoadingSales ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : displaySales.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-4">
                <div className="p-4 bg-muted/50 rounded-full">
                  <BarChart2 className="w-8 h-8 text-muted-foreground" />
                </div>
                <div className="text-center">
                  <p className="text-base font-semibold text-foreground mb-1">No sales records yet</p>
                  <p className="text-sm text-muted-foreground">Import a sales archive or add entries manually.</p>
                </div>
                <div className="flex gap-2">
                  {user?.role === 'admin' && (
                    <Button size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5" onClick={() => srFileInputRef.current?.click()} data-testid="button-sr-empty-import">
                      <Upload className="w-3.5 h-3.5" /> Import sales archive
                    </Button>
                  )}
                  <Button variant="outline" size="sm" className="gap-1.5" data-testid="button-sr-empty-add">
                    <Plus className="w-3.5 h-3.5" /> Add manually
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/30">
                        <th className="w-10 px-3 py-2.5">
                          <Checkbox
                            checked={someVisibleSrSelected ? "indeterminate" : allVisibleSrSelected}
                            onCheckedChange={toggleSrSelectAll}
                            data-testid="checkbox-sr-select-all"
                            aria-label="Select all sales records rows"
                          />
                        </th>
                        <th className="py-2.5 px-3 text-left text-xs font-semibold text-muted-foreground w-10">#</th>
                        <th
                          className="py-2.5 px-3 text-left text-xs font-semibold text-muted-foreground cursor-pointer hover:text-foreground select-none"
                          onClick={() => { if (srSortField === 'saleDate') setSrSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSrSortField('saleDate'); setSrSortDir('desc'); } }}
                        >
                          Sale Date {srSortField === 'saleDate' && (srSortDir === 'asc' ? '↑' : '↓')}
                        </th>
                        <th
                          className="py-2.5 px-3 text-left text-xs font-semibold text-muted-foreground cursor-pointer hover:text-foreground select-none"
                          onClick={() => { if (srSortField === 'brandNumber') setSrSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSrSortField('brandNumber'); setSrSortDir('asc'); } }}
                        >
                          Brand No {srSortField === 'brandNumber' && (srSortDir === 'asc' ? '↑' : '↓')}
                        </th>
                        <th
                          className="py-2.5 px-3 text-left text-xs font-semibold text-muted-foreground cursor-pointer hover:text-foreground select-none"
                          onClick={() => { if (srSortField === 'brandName') setSrSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSrSortField('brandName'); setSrSortDir('asc'); } }}
                        >
                          Brand Name {srSortField === 'brandName' && (srSortDir === 'asc' ? '↑' : '↓')}
                        </th>
                        <th className="py-2.5 px-3 text-left text-xs font-semibold text-muted-foreground">Size</th>
                        <th
                          className="py-2.5 px-3 text-right text-xs font-semibold text-muted-foreground cursor-pointer hover:text-foreground select-none"
                          onClick={() => { if (srSortField === 'soldBottles') setSrSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSrSortField('soldBottles'); setSrSortDir('desc'); } }}
                        >
                          Sold Btls {srSortField === 'soldBottles' && (srSortDir === 'asc' ? '↑' : '↓')}
                        </th>
                        <th
                          className="py-2.5 px-3 text-right text-xs font-semibold text-muted-foreground cursor-pointer hover:text-foreground select-none"
                          onClick={() => { if (srSortField === 'saleValue') setSrSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSrSortField('saleValue'); setSrSortDir('desc'); } }}
                        >
                          Amount {srSortField === 'saleValue' && (srSortDir === 'asc' ? '↑' : '↓')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {displaySales.slice((srPage - 1) * srPageSize, srPage * srPageSize).map((row, idx) => (
                        <tr
                          key={row.id}
                          data-testid={`row-sales-record-${row.id}`}
                          className={`border-b border-border/60 hover:bg-muted/30 transition-colors ${srSelectedIds.has(row.id) ? "bg-primary/5" : ""}`}
                        >
                          <td className="px-3 py-2.5">
                            <Checkbox
                              checked={srSelectedIds.has(row.id)}
                              onCheckedChange={() => toggleSrRow(row.id)}
                              data-testid={`checkbox-sr-row-${row.id}`}
                              aria-label={`Select sales record ${row.id}`}
                            />
                          </td>
                          <td className="py-2.5 px-3 text-muted-foreground text-xs">{(srPage - 1) * srPageSize + idx + 1}</td>
                          <td className="py-2.5 px-3 font-medium text-foreground">{row.saleDate || '—'}</td>
                          <td className="py-2.5 px-3 text-muted-foreground">{row.brandNumber}</td>
                          <td className="py-2.5 px-3 text-foreground">{row.brandName}</td>
                          <td className="py-2.5 px-3 text-muted-foreground">{row.size}</td>
                          <td className="py-2.5 px-3 text-right font-mono text-foreground">{row.soldBottles?.toLocaleString() ?? '—'}</td>
                          <td className="py-2.5 px-3 text-right font-mono text-foreground">
                            {row.totalSaleValue != null
                              ? `₹${parseFloat(row.totalSaleValue as string).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
                              : row.saleValue != null
                              ? `₹${parseFloat(row.saleValue as string).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Pagination */}
                {Math.ceil(displaySales.length / srPageSize) > 1 && (
                  <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-muted/20">
                    <span className="text-xs text-muted-foreground">
                      Showing {(srPage - 1) * srPageSize + 1}–{Math.min(srPage * srPageSize, displaySales.length)} of {displaySales.length}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button variant="outline" size="sm" disabled={srPage === 1} onClick={() => setSrPage(p => p - 1)} className="h-7 px-2 text-xs">Prev</Button>
                      {Array.from({ length: Math.ceil(displaySales.length / srPageSize) }, (_, i) => i + 1).filter(p => p === 1 || p === Math.ceil(displaySales.length / srPageSize) || Math.abs(p - srPage) <= 1).map((p, i, arr) => (
                        <>
                          {i > 0 && arr[i - 1] !== p - 1 && <span key={`ellipsis-${p}`} className="text-xs text-muted-foreground px-1">…</span>}
                          <Button key={p} variant={p === srPage ? 'default' : 'outline'} size="sm" onClick={() => setSrPage(p)} className="h-7 px-2.5 text-xs min-w-[28px]">{p}</Button>
                        </>
                      ))}
                      <Button variant="outline" size="sm" disabled={srPage === Math.ceil(displaySales.length / srPageSize)} onClick={() => setSrPage(p => p + 1)} className="h-7 px-2 text-xs">Next</Button>
                    </div>
                  </div>
                )}
              </>
            )}

            {isSrImporting && (
              <div className="flex items-center gap-2 px-4 py-2 bg-primary/5 border-t border-border text-sm text-primary">
                <Loader2 className="w-4 h-4 animate-spin" /> Importing sales records...
              </div>
            )}
          </div>
        )}

      </div>


      {/* ===================== DIALOGS ===================== */}

      {/* Manual Entry Dialog */}
      <Dialog open={showManualEntryDialog} onOpenChange={setShowManualEntryDialog}>
        <DialogContent className="max-w-[96vw] w-full max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Manual Order Entry</DialogTitle>
            <DialogDescription>Fill in order details manually. Add multiple rows as needed.</DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-auto border border-border rounded-lg table-typography">
            <table className="w-full min-w-[1600px]">
              <thead>
                <tr className="bg-muted/50 border-b border-border">
                  <th className="table-header w-12">#</th>
                  <th className="table-header w-32">Invoice Date</th>
                  <th className="table-header w-48">ICDC Number</th>
                  <th className="table-header w-28">Brand No</th>
                  <th className="table-header w-44">Brand Name</th>
                  <th className="table-header w-24">Type</th>
                  <th className="table-header w-20">Pack</th>
                  <th className="table-header w-36">Size (ml)</th>
                  <th className="table-header w-24 text-right bg-blue-50/50">Cases</th>
                  <th className="table-header w-24 text-right bg-blue-50/50">Bottles</th>
                  <th className="table-header w-28 text-right">Rate/Case</th>
                  <th className="table-header w-28 text-right">Rate/Btl</th>
                  <th className="table-header w-32 text-right text-primary bg-primary/5">Total</th>
                  <th className="table-header w-28 text-right">Breakage</th>
                  <th className="table-header w-12"></th>
                </tr>
              </thead>
              <tbody>
                {paginatedRows.map((row, idx) => {
                  const gi = (currentPage - 1) * pageSize + idx;
                  return (
                    <tr key={gi} className="hover:bg-muted/30 transition-colors">
                      <td className="table-cell text-center text-muted-foreground">{gi + 1}</td>
                      <td className="p-2 border-b border-border"><DatePickerInput className="w-full text-sm" value={row.invoiceDate || ""} onChange={(val) => handleRowChange(idx, "invoiceDate", val)} /></td>
                      <td className="p-2 border-b border-border"><input className="input-field font-mono text-sm" placeholder="e.g. ICDC019..." value={row.icdcNumber || ""} onChange={e => handleRowChange(idx, "icdcNumber", e.target.value)} /></td>
                      <td className="p-2 border-b border-border"><input className="input-field" placeholder="Ex: 3066" value={row.brandNumber} onChange={e => handleRowChange(idx, "brandNumber", e.target.value)} /></td>
                      <td className="p-2 border-b border-border"><input className="input-field" placeholder="Brand Name" value={row.brandName} onChange={e => handleRowChange(idx, "brandName", e.target.value)} /></td>
                      <td className="p-2 border-b border-border"><input className="input-field" placeholder="Beer, IML..." value={row.productType} onChange={e => handleRowChange(idx, "productType", e.target.value)} /></td>
                      <td className="p-2 border-b border-border"><select className="input-field" value={row.packType} onChange={e => handleRowChange(idx, "packType", e.target.value)}>{PACK_TYPES.map(t => <option key={t}>{t}</option>)}</select></td>
                      <td className="p-2 border-b border-border"><select className="input-field" value={row.packSize} onChange={e => handleRowChange(idx, "packSize", e.target.value)}>{PACK_SIZES.map(s => <option key={s}>{s}</option>)}</select></td>
                      <td className="p-2 border-b border-border bg-blue-50/10"><input type="number" className="input-field text-right font-mono" value={row.qtyCasesDelivered ?? 0} onChange={e => handleRowChange(idx, "qtyCasesDelivered", parseInt(e.target.value, 10) || 0)} /></td>
                      <td className="p-2 border-b border-border bg-blue-50/10"><input type="number" className="input-field text-right font-mono" value={row.qtyBottlesDelivered ?? 0} onChange={e => handleRowChange(idx, "qtyBottlesDelivered", parseInt(e.target.value, 10) || 0)} /></td>
                      <td className="p-2 border-b border-border"><input type="number" className="input-field text-right font-mono" value={row.ratePerCase || ""} onChange={e => handleRowChange(idx, "ratePerCase", e.target.value)} /></td>
                      <td className="p-2 border-b border-border"><input type="number" className="input-field text-right font-mono" value={row.unitRatePerBottle || ""} onChange={e => handleRowChange(idx, "unitRatePerBottle", e.target.value)} /></td>
                      <td className="table-cell text-right font-bold text-primary font-mono bg-primary/5">₹{fmt2(row.totalAmount)}</td>
                      <td className="p-2 border-b border-border"><input type="number" className="input-field text-right font-mono" value={row.breakageBottleQty ?? 0} onChange={e => handleRowChange(idx, "breakageBottleQty", parseInt(e.target.value, 10) || 0)} /></td>
                      <td className="p-2 border-b border-border text-center"><button onClick={() => removeRow(idx)} disabled={rows.length === 1} className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded disabled:opacity-30"><Trash2 className="w-4 h-4" /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {totalManualPages > 1 && <PaginationCustom currentPage={currentPage} totalPages={totalManualPages} pageSize={pageSize} onPageChange={setCurrentPage} onPageSizeChange={(s) => { setPageSize(s); setCurrentPage(1); }} totalItems={rows.length} />}
          <div className="flex items-center justify-between pt-2 flex-wrap gap-2">
            <button onClick={addRow} className="flex items-center gap-2 px-4 py-2 border border-dashed border-border rounded-lg text-muted-foreground hover:border-primary/50 hover:text-primary hover:bg-primary/5 transition-all text-sm">
              <Plus className="w-4 h-4" /> Add Row
            </button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setShowManualEntryDialog(false)}>Cancel</Button>
              <Button onClick={handleSubmitOrders} disabled={isSaving}>
                {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                Save Orders
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Preview Dialog */}
      <Dialog open={showPreview} onOpenChange={(open) => { if (!open) handleRejectUpload(); }}>
        <DialogContent className="max-w-[95vw] w-full max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle data-testid="text-preview-title">Review Uploaded Orders</DialogTitle>
            <DialogDescription><span className="font-medium">{previewFilename}</span> — {previewOrders.length} order(s) extracted. Review and confirm to save.</DialogDescription>
            {(previewOrders[0]?.invoiceDate || previewOrders[0]?.icdcNumber) && (
              <div className="flex flex-wrap gap-4 mt-2 text-sm">
                {previewOrders[0]?.invoiceDate && <span className="px-3 py-1 bg-muted rounded-md" data-testid="text-preview-invoice-date"><span className="text-muted-foreground">Invoice Date:</span> <span className="font-semibold">{formatDMY(previewOrders[0].invoiceDate)}</span></span>}
                {previewOrders[0]?.icdcNumber && <span className="px-3 py-1 bg-muted rounded-md" data-testid="text-preview-icdc-number"><span className="text-muted-foreground">ICDC:</span> <span className="font-semibold">{previewOrders[0].icdcNumber}</span></span>}
              </div>
            )}
          </DialogHeader>
          <div className="flex-1 overflow-auto border border-border rounded-lg table-typography">
            <table className="w-full min-w-[1200px]">
              <thead>
                <tr className="bg-muted/50 border-b border-border sticky top-0 z-10">
                  <th className="table-header w-12">#</th>
                  <th className="table-header w-28">Brand No</th>
                  <th className="table-header w-48">Brand Name</th>
                  <th className="table-header w-20">Type</th>
                  <th className="table-header w-16">Pack</th>
                  <th className="table-header w-32">Size (ml)</th>
                  <th className="table-header w-24 text-right bg-blue-50/50">Cases</th>
                  <th className="table-header w-24 text-right bg-blue-50/50">Bottles</th>
                  <th className="table-header w-28 text-right">Rate/Case</th>
                  <th className="table-header w-28 text-right">Rate/Btl</th>
                  <th className="table-header w-32 text-right text-primary bg-primary/5">Total</th>
                  <th className="table-header w-24 text-right">Breakage</th>
                  <th className="table-header w-36">Remarks</th>
                </tr>
              </thead>
              <tbody>
                {paginatedPreview.map((row, idx) => {
                  const gi = (previewPage - 1) * previewPageSize + idx;
                  return (
                    <tr key={gi} className="hover:bg-muted/30 transition-colors" data-testid={`row-preview-order-${gi}`}>
                      <td className="table-cell text-center text-muted-foreground">{gi + 1}</td>
                      <td className="table-cell font-mono text-sm">{row.brandNumber}</td>
                      <td className="table-cell text-sm">{row.brandName}</td>
                      <td className="table-cell text-sm">{row.productType}</td>
                      <td className="table-cell text-sm">{row.packType}</td>
                      <td className="table-cell text-sm">{row.packSize}</td>
                      <td className="table-cell text-right font-mono text-sm bg-blue-50/10">{row.qtyCasesDelivered}</td>
                      <td className="table-cell text-right font-mono text-sm bg-blue-50/10">{row.qtyBottlesDelivered}</td>
                      <td className="table-cell text-right font-mono text-sm">{fmt2(row.ratePerCase)}</td>
                      <td className="table-cell text-right font-mono text-sm">{fmt2(row.unitRatePerBottle)}</td>
                      <td className="table-cell text-right font-bold text-primary font-mono bg-primary/5">{fmt2(row.totalAmount)}</td>
                      <td className="table-cell text-right font-mono text-sm">{row.breakageBottleQty}</td>
                      <td className="table-cell text-sm text-muted-foreground">{row.remarks || "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {previewTotalPages > 1 && (
            <div className="flex items-center justify-between pt-2 text-sm text-muted-foreground">
              <span>Showing {(previewPage - 1) * previewPageSize + 1}-{Math.min(previewPage * previewPageSize, previewOrders.length)} of {previewOrders.length}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={previewPage <= 1} onClick={() => setPreviewPage(p => p - 1)} data-testid="button-preview-prev">Previous</Button>
                <Button variant="outline" size="sm" disabled={previewPage >= previewTotalPages} onClick={() => setPreviewPage(p => p + 1)} data-testid="button-preview-next">Next</Button>
              </div>
            </div>
          )}
          <DialogFooter className="gap-3 pt-2">
            <Button variant="outline" onClick={handleRejectUpload} data-testid="button-reject-upload"><XCircle className="w-4 h-4 mr-2" />Reject</Button>
            <Button onClick={handleConfirmUpload} disabled={isSaving} data-testid="button-confirm-upload">
              {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
              Confirm & Save ({previewOrders.length} orders)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Shop Details Dialog */}
      <Dialog open={showShopDetail} onOpenChange={setShowShopDetail}>
        <DialogContent className="max-w-lg" data-testid="dialog-shop-detail">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Store className="w-5 h-5" />Shop Details</DialogTitle>
            <DialogDescription>Details extracted from the invoice PDF header</DialogDescription>
          </DialogHeader>
          {isLoadingShopDetail ? (
            <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
          ) : shopDetailData ? (
            <div className="space-y-3">
              {[{ label: "Name", value: shopDetailData.name }, { label: "Address", value: shopDetailData.address }, { label: "Retail Shop Excise Tax", value: shopDetailData.retailShopExciseTax }, { label: "License No", value: shopDetailData.licenseNo }, { label: "PAN Number", value: shopDetailData.panNumber }, { label: "Name & Phone", value: shopDetailData.namePhone }, { label: "Invoice Date", value: shopDetailData.invoiceDate }, { label: "Gazette Code & Licensee Issue Date", value: shopDetailData.gazetteCodeLicenseeIssueDate }, { label: "ICDC Number", value: shopDetailData.icdcNumber }].map(item => (
                <div key={item.label} className="flex flex-col gap-0.5" data-testid={`text-shop-${item.label.toLowerCase().replace(/\s+/g, "-")}`}>
                  <span className="text-xs font-medium text-muted-foreground">{item.label}</span>
                  <span className="text-sm text-foreground">{item.value != null && item.value !== "" ? String(item.value) : "-"}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <p className="text-sm">No shop details found for this ICDC number.</p>
              <p className="text-xs mt-1">Shop details are extracted when a PDF invoice is uploaded.</p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Duplicate Invoice Dialog */}
      <Dialog open={showDuplicateDialog} onOpenChange={(open) => { if (!open) { setShowDuplicateDialog(false); setPendingUploadData(null); setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; } }}>
        <DialogContent className="max-w-sm" data-testid="dialog-duplicate-invoice">
          <DialogHeader>
            <DialogTitle className="text-amber-600 flex items-center gap-2"><span>⚠</span> Invoice Already Uploaded!</DialogTitle>
            <DialogDescription className="pt-2">An invoice with the same Invoice Date and ICDC Number already exists. Please check and try a different invoice.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 pt-2">
            <Button variant="outline" data-testid="button-duplicate-cancel" onClick={() => { setShowDuplicateDialog(false); setPendingUploadData(null); setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
