
import { 
  dailySales, orders, stockDetails, users, shopDetails, salesSubmitStatus, dailyStock, salesMrpDetails,
  expenseCategories, dailyExpenses,
  type DailySale, type InsertDailySale,
  type Order, type InsertOrder,
  type StockDetail, type InsertStockDetail,
  type User, type InsertUser,
  type ShopDetail, type InsertShopDetail,
  type SalesSubmitStatus,
  type DailyStock,
  type SalesMrpDetail, type InsertSalesMrpDetail,
  type ExpenseCategory, type InsertExpenseCategory,
  type DailyExpense, type InsertDailyExpense,
} from "@workspace/db";
import { eq, and, sql, desc, asc, inArray, lt } from "drizzle-orm";
import { pool, db, mainPool, getActiveSchema } from "./db";
import session from "express-session";
import connectPg from "connect-pg-simple";

// ── Simple in-memory TTL cache ─────────────────────────────────────────────
// Prevents repetitive full-table scans for read-heavy, rarely-mutated data
// (orders, stock_details, sales_mrp_details) on every Sales page load.
//
// IMPORTANT: all keys are prefixed with the active schema so that data cached
// for one shop (e.g. balaji_schema) is never returned to a request running in
// a different shop's context (e.g. jyothi_schema).
const _cache = new Map<string, { data: unknown; expiry: number }>();

/** Scope a bare cache key to the currently-active shop schema. */
function _scopedKey(key: string): string {
  return `${getActiveSchema()}:${key}`;
}

function _getCache<T>(key: string): T | null {
  const scoped = _scopedKey(key);
  const entry = _cache.get(scoped);
  if (!entry || Date.now() > entry.expiry) { _cache.delete(scoped); return null; }
  return entry.data as T;
}
function _setCache<T>(key: string, data: T, ttlMs: number): T {
  _cache.set(_scopedKey(key), { data, expiry: Date.now() + ttlMs });
  return data;
}
function _invalidate(...keys: string[]) { keys.forEach(k => _cache.delete(_scopedKey(k))); }
// ──────────────────────────────────────────────────────────────────────────

// Sort brand_number numerically by its leading digits; brand_numbers that do
// not start with a digit (e.g. "TEST-Z") fall back to alphabetical order at
// the end of the list. Plain `CAST(brand_number AS INTEGER)` throws and turns
// into a 500 the moment a non-numeric value enters the table, breaking the
// Sales tab for everyone.
const brandNumberOrder = sql`(NULLIF(substring(brand_number FROM '^[0-9]+'), ''))::int NULLS LAST, brand_number ASC`;

const PostgresSessionStore = connectPg(session);

export interface IStorage {
  // Users
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUsersByRole(role: User["role"]): Promise<User[]>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: number, user: Partial<User>): Promise<User>;
  
  // Sales
  getDailySales(): Promise<DailySale[]>;
  getDailySalesByDate(date: string): Promise<DailySale[]>;
  getEarliestInvoiceDate(): Promise<string | null>;
  getAvailableSalesDates(): Promise<string[]>;
  bulkUpdateDailySales(sales: InsertDailySale[]): Promise<DailySale[]>;
  bulkUpdateDailySalesForDate(sales: InsertDailySale[], date: string): Promise<DailySale[]>;
  deleteDailySale(id: number): Promise<void>;
  deleteAndRevertSales(ids: number[], date: string): Promise<void>;
  submitSalesForDate(date: string): Promise<number>;
  isSalesSubmittedForDate(date: string): Promise<boolean>;
  getSubmitStatus(date: string): Promise<SalesSubmitStatus | undefined>;
  
  // Orders
  getOrders(): Promise<Order[]>;
  getBrandTypes(): Promise<{ brandNumber: string; productType: string }[]>;
  bulkCreateOrders(orders: InsertOrder[]): Promise<Order[]>;
  updateOrder(id: number, data: Record<string, any>): Promise<Order>;
  deleteOrder(id: number): Promise<void>;
  getLatestOrderInvoiceDate(): Promise<string | null>;
  getEarliestOrderInvoiceDate(): Promise<string | null>;

  // Stock
  getStockDetails(): Promise<StockDetail[]>;
  populateStockFromLatestSnapshot(): Promise<void>;
  bulkUpdateStockDetails(stock: InsertStockDetail[]): Promise<StockDetail[]>;
  syncOrdersToStock(): Promise<{ syncedOrderIds: number[]; updatedStockCount: number }>;
  syncStockToDailySales(): Promise<{ updatedSalesCount: number; createdSalesCount: number }>;
  syncDailySalesToStock(date?: string): Promise<{ updatedStockCount: number }>;

  // Daily Stock Snapshots
  getDailyStockByDate(date: string): Promise<DailyStock[]>;
  getAvailableStockDates(): Promise<string[]>;
  getMostRecentDailyStockBefore(date: string): Promise<DailyStock[]>;
  upsertDailyStockSnapshot(date: string): Promise<void>;
  replaceFullDailyStockSnapshot(date: string): Promise<void>;

  // Archive / bulk import of historical daily sales (multi-date)
  bulkImportDailySales(rows: InsertDailySale[]): Promise<number>;

  // Sales MRP Overrides
  getSalesMrpDetails(): Promise<SalesMrpDetail[]>;
  upsertSalesMrpDetail(data: InsertSalesMrpDetail): Promise<SalesMrpDetail>;
  bulkUpsertSalesMrpDetails(data: InsertSalesMrpDetail[]): Promise<number>;
  deleteSalesMrpDetail(id: number): Promise<boolean>;

  // Shop Details
  createShopDetail(shop: InsertShopDetail): Promise<ShopDetail>;
  getShopDetails(): Promise<ShopDetail[]>;
  getShopDetailByLicenseNo(licenseNo: string): Promise<ShopDetail | undefined>;
  getShopDetailByIcdcNumber(icdcNumber: string): Promise<ShopDetail | undefined>;

  // Expense Categories
  getExpenseCategories(type?: string): Promise<ExpenseCategory[]>;
  createExpenseCategory(data: InsertExpenseCategory): Promise<ExpenseCategory>;
  deleteExpenseCategory(id: number): Promise<boolean>;

  // Daily Expenses
  getDailyExpenses(date: string): Promise<DailyExpense[]>;
  createDailyExpense(data: InsertDailyExpense): Promise<DailyExpense>;
  updateDailyExpense(id: number, data: Partial<InsertDailyExpense>): Promise<DailyExpense>;
  deleteDailyExpense(id: number): Promise<boolean>;

  sessionStore: session.Store;
}

export class DatabaseStorage implements IStorage {
  sessionStore: session.Store;

  constructor() {
    // Use the shared pool (not a separate conObject) so the session store
    // inherits the search_path that pool.on("connect") sets for every
    // connection. This means:
    //   • createTableIfMissing creates "session" inside the right schema
    //     automatically — no explicit schemaName qualification needed.
    //   • A separate conObject would bypass the search_path hook and try
    //     to create/query the session table in the "public" schema, which
    //     causes silent session-save failures → 401 on every request after
    //     a successful login.
    const store = new PostgresSessionStore({
      pool: mainPool,
      createTableIfMissing: true,
    });

    // express-session silently swallows store errors by default.
    // Surfacing them here means "session save failed → 401 on all requests"
    // becomes visible immediately in the server log instead of being a
    // mystery.  The most common cause on EC2 is the schema not existing yet
    // (DB_SCHEMA=balaji_schema but CREATE SCHEMA was never run) or a DB
    // credential / network issue.
    store.on("error", (err: Error) => {
      // eslint-disable-next-line no-console
      console.error("[session-store] ERROR — sessions cannot be saved, every request will return 401:", err.message);
    });

    this.sessionStore = store;
  }

  // User methods
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async getUsersByRole(role: User["role"]): Promise<User[]> {
    return await db.select().from(users).where(eq(users.role, role));
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async updateUser(id: number, partialUser: Partial<User>): Promise<User> {
    const [user] = await db.update(users).set(partialUser).where(eq(users.id, id)).returning();
    return user;
  }

  // Sales
  async getDailySales(): Promise<DailySale[]> {
    return await db.select().from(dailySales).orderBy(brandNumberOrder);
  }

  async getDailySalesByDate(date: string): Promise<DailySale[]> {
    return await db.select().from(dailySales).where(eq(dailySales.saleDate, date)).orderBy(brandNumberOrder);
  }

  async getEarliestInvoiceDate(): Promise<string | null> {
    const result = await db
      .select({ invoiceDate: dailySales.invoiceDate })
      .from(dailySales)
      .where(sql`${dailySales.invoiceDate} IS NOT NULL`)
      .orderBy(asc(dailySales.invoiceDate))
      .limit(1);
    return result[0]?.invoiceDate ?? null;
  }

  async getAvailableSalesDates(): Promise<string[]> {
    const result = await db
      .selectDistinct({ saleDate: dailySales.saleDate })
      .from(dailySales)
      .where(sql`${dailySales.saleDate} IS NOT NULL`)
      .orderBy(asc(dailySales.saleDate));
    return result.map(r => r.saleDate).filter(Boolean) as string[];
  }

  async bulkUpdateDailySales(salesData: InsertDailySale[]): Promise<DailySale[]> {
    if (salesData.length === 0) return [];
    const today = new Date().toISOString().split('T')[0];
    return await db.insert(dailySales)
      .values(salesData.map(sale => ({ ...sale, saleDate: today })))
      .onConflictDoUpdate({
        target: [dailySales.brandNumber, dailySales.size, dailySales.saleDate],
        set: {
          quantityPerCase: sql`excluded.quantity_per_case`,
          openingBalanceBottles: sql`excluded.opening_balance_bottles`,
          newStockCases: sql`excluded.new_stock_cases`,
          newStockBottles: sql`excluded.new_stock_bottles`,
          closingBalanceCases: sql`excluded.closing_balance_cases`,
          closingBalanceBottles: sql`excluded.closing_balance_bottles`,
          soldBottles: sql`excluded.sold_bottles`,
          saleValue: sql`excluded.sale_value`,
          totalSaleValue: sql`excluded.total_sale_value`,
          breakageBottles: sql`excluded.breakage_bottles`,
          totalClosingStock: sql`excluded.total_closing_stock`,
          finalClosingBalance: sql`excluded.final_closing_balance`,
          mrp: sql`excluded.mrp`,
          invoiceDate: sql`excluded.invoice_date`,
        }
      })
      .returning();
  }

  async bulkUpdateDailySalesForDate(salesData: InsertDailySale[], date: string): Promise<DailySale[]> {
    if (salesData.length === 0) return [];
    // Deduplicate by conflict key (brandNumber, size) — keep the last occurrence
    const deduped = Array.from(
      salesData.reduce((map, sale) => {
        const key = `${sale.brandNumber}|${sale.size}`;
        map.set(key, sale);
        return map;
      }, new Map<string, InsertDailySale>()).values()
    );
    return await db.insert(dailySales)
      .values(deduped.map(sale => ({ ...sale, saleDate: date, isSubmitted: false })))
      .onConflictDoUpdate({
        target: [dailySales.brandNumber, dailySales.size, dailySales.saleDate],
        set: {
          quantityPerCase: sql`excluded.quantity_per_case`,
          openingBalanceBottles: sql`excluded.opening_balance_bottles`,
          newStockCases: sql`excluded.new_stock_cases`,
          newStockBottles: sql`excluded.new_stock_bottles`,
          closingBalanceCases: sql`excluded.closing_balance_cases`,
          closingBalanceBottles: sql`excluded.closing_balance_bottles`,
          soldBottles: sql`excluded.sold_bottles`,
          saleValue: sql`excluded.sale_value`,
          totalSaleValue: sql`excluded.total_sale_value`,
          breakageBottles: sql`excluded.breakage_bottles`,
          totalClosingStock: sql`excluded.total_closing_stock`,
          finalClosingBalance: sql`excluded.final_closing_balance`,
          mrp: sql`excluded.mrp`,
          invoiceDate: sql`excluded.invoice_date`,
        }
      })
      .returning();
  }

  async bulkImportDailySales(rows: InsertDailySale[]): Promise<number> {
    if (rows.length === 0) return 0;
    // Deduplicate: keep last occurrence per (brandNumber, size, saleDate)
    const deduped = Array.from(
      rows.reduce((map, row) => {
        const key = `${row.brandNumber}|${row.size}|${row.saleDate}`;
        map.set(key, row);
        return map;
      }, new Map<string, InsertDailySale>()).values()
    );

    // Process in batches of 100 to avoid call stack overflow on large files
    const BATCH_SIZE = 100;
    let totalSaved = 0;
    for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
      const batch = deduped.slice(i, i + BATCH_SIZE);
      const result = await db.insert(dailySales)
        .values(batch)
        .onConflictDoUpdate({
          target: [dailySales.brandNumber, dailySales.size, dailySales.saleDate],
          set: {
            brandName: sql`excluded.brand_name`,
            quantityPerCase: sql`excluded.quantity_per_case`,
            openingBalanceBottles: sql`excluded.opening_balance_bottles`,
            newStockCases: sql`excluded.new_stock_cases`,
            newStockBottles: sql`excluded.new_stock_bottles`,
            closingBalanceCases: sql`excluded.closing_balance_cases`,
            closingBalanceBottles: sql`excluded.closing_balance_bottles`,
            soldBottles: sql`excluded.sold_bottles`,
            saleValue: sql`excluded.sale_value`,
            totalSaleValue: sql`excluded.total_sale_value`,
            breakageBottles: sql`excluded.breakage_bottles`,
            totalClosingStock: sql`excluded.total_closing_stock`,
            finalClosingBalance: sql`excluded.final_closing_balance`,
            mrp: sql`excluded.mrp`,
            invoiceDate: sql`excluded.invoice_date`,
          }
        })
        .returning();
      totalSaved += result.length;
    }
    return totalSaved;
  }

  async deleteDailySale(id: number): Promise<void> {
    await db.delete(dailySales).where(eq(dailySales.id, id));
  }

  async deleteAndRevertSales(ids: number[], date: string): Promise<void> {
    if (ids.length === 0) return;

    // 1. Capture the rows we are about to delete (need brand info for stock revert)
    const toDelete = await db.select().from(dailySales).where(
      sql`id = ANY(ARRAY[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::int[])`
    );

    // 2. Delete from daily_sales
    await db.delete(dailySales).where(
      sql`id = ANY(ARRAY[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::int[])`
    );

    if (toDelete.length === 0) return;

    // 3. Revert stock_details for deleted brands: use previous day's daily_stock if available,
    //    otherwise fall back to the opening balance stored in the deleted row.
    const prevDate = (() => {
      const d = new Date(date);
      d.setDate(d.getDate() - 1);
      return d.toISOString().split('T')[0];
    })();
    const prevSnapshot = await db.select().from(dailyStock).where(eq(dailyStock.date, prevDate));

    const normStr = (s: string) => (s ?? '').trim().toLowerCase().replace(/\s+/g, '');
    const sizeMatch = (a: string, b: string) => {
      const na = normStr(a), nb = normStr(b);
      return na === nb || na.includes(nb) || nb.includes(na);
    };

    const allStock = await db.select().from(stockDetails);

    for (const sale of toDelete) {
      // Find matching stock_details row
      const matchedStock = allStock.find(s =>
        s.brandNumber === sale.brandNumber &&
        normStr(s.brandName) === normStr(sale.brandName) &&
        sizeMatch(s.size ?? '', sale.size)
      ) ?? allStock.find(s =>
        s.brandNumber === sale.brandNumber &&
        sizeMatch(s.size ?? '', sale.size)
      );

      if (!matchedStock) continue;

      // Find matching previous-day snapshot
      const prevRow = prevSnapshot.find(p =>
        p.brandNumber === sale.brandNumber &&
        normStr(p.brandName) === normStr(sale.brandName) &&
        sizeMatch(p.size ?? '', sale.size)
      ) ?? prevSnapshot.find(p =>
        p.brandNumber === sale.brandNumber &&
        sizeMatch(p.size ?? '', sale.size)
      );

      // Revert values: prefer prev-day snapshot, else use opening balance from deleted row
      const revertBtls = prevRow ? (prevRow.totalStockBottles ?? 0) : (sale.openingBalanceBottles ?? 0);
      const revertCases = prevRow ? (prevRow.stockInCases ?? 0) : 0;
      const revertBottles = prevRow ? (prevRow.stockInBottles ?? 0) : 0;
      const mrp = parseFloat(String(matchedStock.mrp ?? '0')) || 0;

      await db.update(stockDetails)
        .set({
          stockInCases: revertCases,
          stockInBottles: revertBottles,
          totalStockBottles: revertBtls,
          totalStockValue: (revertBtls * mrp).toFixed(2),
        })
        .where(eq(stockDetails.id, matchedStock.id));
    }
  }

  async submitSalesForDate(date: string): Promise<number> {
    // Mark all daily_sales rows for this date as submitted
    const result = await db.update(dailySales)
      .set({ isSubmitted: true })
      .where(eq(dailySales.saleDate, date))
      .returning();
    
    // Upsert into authoritative submit_status table
    await db.insert(salesSubmitStatus)
      .values({ date, isSubmitted: true, submittedAt: new Date() })
      .onConflictDoUpdate({
        target: [salesSubmitStatus.date],
        set: { isSubmitted: true, submittedAt: new Date() },
      });

    return result.length;
  }

  async isSalesSubmittedForDate(date: string): Promise<boolean> {
    // Check the authoritative submit_status table first
    const [status] = await db.select()
      .from(salesSubmitStatus)
      .where(and(eq(salesSubmitStatus.date, date), eq(salesSubmitStatus.isSubmitted, true)))
      .limit(1);
    return !!status;
  }

  async getSubmitStatus(date: string): Promise<SalesSubmitStatus | undefined> {
    const [status] = await db.select().from(salesSubmitStatus).where(eq(salesSubmitStatus.date, date)).limit(1);
    return status;
  }

  // Orders
  async getOrders(): Promise<Order[]> {
    const cached = _getCache<Order[]>('orders');
    if (cached) return cached;
    const result = await db.select().from(orders).orderBy(desc(orders.invoiceDate), desc(orders.id));
    return _setCache('orders', result, 60_000); // 60s TTL
  }

  async getBrandTypes(): Promise<{ brandNumber: string; productType: string }[]> {
    const cached = _getCache<{ brandNumber: string; productType: string }[]>('brandTypes');
    if (cached) return cached;
    const rows = await db
      .selectDistinct({ brandNumber: orders.brandNumber, productType: orders.productType })
      .from(orders)
      .where(sql`${orders.brandNumber} IS NOT NULL AND ${orders.brandNumber} != '' AND ${orders.productType} IS NOT NULL AND ${orders.productType} != ''`);
    return _setCache('brandTypes', rows, 300_000); // 5 minute TTL
  }

  async getLatestOrderInvoiceDate(): Promise<string | null> {
    const cached = _getCache<string>('latestInvoiceDate');
    if (cached !== null) return cached;
    // invoice_date is now a proper date column — ORDER BY gives correct calendar order
    const result = await db
      .select({ invoiceDate: orders.invoiceDate })
      .from(orders)
      .where(sql`${orders.invoiceDate} IS NOT NULL`)
      .orderBy(desc(orders.invoiceDate))
      .limit(1);
    const date = result[0]?.invoiceDate ?? null;
    return _setCache('latestInvoiceDate', date, 600_000);
  }

  async getEarliestOrderInvoiceDate(): Promise<string | null> {
    const cached = _getCache<string>('earliestInvoiceDate');
    if (cached !== null) return cached;
    // invoice_date is now a proper date column — ORDER BY gives correct calendar order
    const result = await db
      .select({ invoiceDate: orders.invoiceDate })
      .from(orders)
      .where(sql`${orders.invoiceDate} IS NOT NULL`)
      .orderBy(asc(orders.invoiceDate))
      .limit(1);
    const date = result[0]?.invoiceDate ?? null;
    return _setCache('earliestInvoiceDate', date, 600_000);
  }

  async bulkCreateOrders(ordersData: InsertOrder[]): Promise<Order[]> {
    if (ordersData.length === 0) return [];
    const withTotalBottles = ordersData.map(order => {
      const packParts = order.packSize.split("/").map((s: string) => s.trim());
      const qtyPerCase = packParts.length > 0 ? parseInt(packParts[0], 10) : 0;
      const totalBottles = (isNaN(qtyPerCase) ? 0 : qtyPerCase) * (order.qtyCasesDelivered ?? 0) + (order.qtyBottlesDelivered ?? 0);
      return { ...order, totalBottles };
    });
    const result = await db.insert(orders).values(withTotalBottles).returning();
    _invalidate('orders', 'brandTypes', 'latestInvoiceDate', 'earliestInvoiceDate');
    return result;
  }

  async updateOrder(id: number, data: Record<string, any>): Promise<Order> {
    // Strip fields that must not be overwritten (id, auto timestamps, flags, computed columns)
    const { id: _id, createdAt: _ca, dataUpdated: _du, totalBottles: _tb, ...fields } = data;

    const current = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (current.length === 0) throw new Error(`Order ${id} not found`);
    const merged = { ...current[0], ...fields };

    // Recompute totalBottles from packSize / qty
    const packParts = (merged.packSize || "").split("/").map((s: string) => s.trim());
    const qtyPerCase = parseInt(packParts[0], 10);
    const totalBottles = (isNaN(qtyPerCase) ? 0 : qtyPerCase) * (merged.qtyCasesDelivered ?? 0) + (merged.qtyBottlesDelivered ?? 0);

    const result = await db.update(orders).set({ ...fields, totalBottles }).where(eq(orders.id, id)).returning();
    _invalidate('orders', 'brandTypes');
    return result[0];
  }

  async deleteOrder(id: number): Promise<void> {
    await db.delete(orders).where(eq(orders.id, id));
    _invalidate('orders', 'brandTypes');
  }

  // Stock
  async getStockDetails(): Promise<StockDetail[]> {
    const cached = _getCache<StockDetail[]>('stockDetails');
    if (cached) return cached;
    const existing = await db.select().from(stockDetails).orderBy(brandNumberOrder);
    if (existing.length === 0) {
      // Auto-populate from the most recent daily_stock snapshot
      await this.populateStockFromLatestSnapshot();
      return _setCache('stockDetails', await db.select().from(stockDetails).orderBy(brandNumberOrder), 30_000);
    }
    return _setCache('stockDetails', existing, 30_000); // 30s TTL
  }

  async populateStockFromLatestSnapshot(): Promise<void> {
    const latestRows = await db
      .select()
      .from(dailyStock)
      .orderBy(desc(dailyStock.date))
      .limit(500);
    if (latestRows.length === 0) return;
    const mostRecentDate = latestRows[0].date;
    const recentRows = latestRows.filter((r) => r.date === mostRecentDate);
    if (recentRows.length === 0) return;
    // Batch insert instead of N individual inserts
    await db.insert(stockDetails).values(recentRows.map(row => ({
      brandNumber: row.brandNumber,
      brandName: row.brandName,
      size: row.size,
      quantityPerCase: row.quantityPerCase,
      stockInCases: row.stockInCases ?? 0,
      stockInBottles: row.stockInBottles ?? 0,
      totalStockBottles: row.totalStockBottles ?? 0,
      mrp: row.mrp || '0',
      totalStockValue: row.totalStockValue || '0',
      breakage: row.breakage ?? 0,
    })));
    console.log(`[populateStockFromLatestSnapshot] Inserted ${recentRows.length} rows from daily_stock date=${mostRecentDate}`);
  }

  async bulkUpdateStockDetails(stockData: InsertStockDetail[]): Promise<StockDetail[]> {
    const results: StockDetail[] = [];
    const today = new Date().toISOString().split('T')[0];

    for (const item of stockData) {
      const [created] = await db.insert(stockDetails)
        .values({ ...item, invoiceDate: item.invoiceDate ?? today })
        .returning();
      results.push(created);
    }
    _invalidate('stockDetails');
    return results;
  }

  async syncOrdersToStock(): Promise<{ syncedOrderIds: number[]; updatedStockCount: number }> {
    const unsyncedOrders = await db
      .select()
      .from(orders)
      .where(eq(orders.dataUpdated, "NO"));

    if (unsyncedOrders.length === 0) {
      return { syncedOrderIds: [], updatedStockCount: 0 };
    }

    const allStock = await db.select().from(stockDetails);

    const normalizeBrand = (b: string) => b.replace(/^0+/, '') || '0';
    const normalizeName = (n: string) => n.trim().toLowerCase().replace(/\s+/g, "");

    const extractSizeFromPackSize = (packSize: string): string => {
      const parts = packSize.split("/");
      if (parts.length >= 2) return parts[1].trim();
      return packSize.trim();
    };

    const extractQtyPerCaseFromPackSize = (packSize: string): number => {
      const parts = packSize.split("/");
      if (parts.length >= 1) {
        const num = parseInt(parts[0].trim(), 10);
        return isNaN(num) ? 0 : num;
      }
      return 0;
    };

    type AggValue = {
      stockId: number | null;
      brandNumber: string;
      brandName: string;
      size: string;
      quantityPerCase: number;
      mrpPerBottle: number;
      casesDelivered: number;
      bottlesDelivered: number;
      totalBottles: number;
      orderIds: number[];
      invoiceDate: string | null;
    };

    const updateAgg = new Map<string, AggValue>();
    const createAgg = new Map<string, AggValue>();

    for (const order of unsyncedOrders) {
      const orderBrandNorm = normalizeBrand(order.brandNumber);
      const orderNameNorm = normalizeName(order.brandName);
      const orderSize = extractSizeFromPackSize(order.packSize);
      const orderSizeNorm = orderSize.toLowerCase().replace(/\s+/g, "");

      const matchedStock = allStock.find(s => {
        if (normalizeBrand(s.brandNumber) !== orderBrandNorm) return false;
        if (normalizeName(s.brandName) !== orderNameNorm) return false;
        const stockSizeNorm = s.size.trim().toLowerCase().replace(/\s+/g, "");
        return stockSizeNorm === orderSizeNorm;
      });

      const compositeKey = `${orderBrandNorm}|${orderNameNorm}|${orderSizeNorm}`;
      const aggMap = matchedStock ? updateAgg : createAgg;

      const existing = aggMap.get(compositeKey);
      if (existing) {
        existing.casesDelivered += order.qtyCasesDelivered ?? 0;
        existing.bottlesDelivered += order.qtyBottlesDelivered ?? 0;
        existing.totalBottles += order.totalBottles ?? 0;
        existing.orderIds.push(order.id);
        // Keep the most recent invoice date
        if (order.invoiceDate && (!existing.invoiceDate || order.invoiceDate > existing.invoiceDate)) {
          existing.invoiceDate = order.invoiceDate;
        }
      } else {
        aggMap.set(compositeKey, {
          stockId: matchedStock ? matchedStock.id : null,
          brandNumber: order.brandNumber,
          brandName: order.brandName,
          size: orderSize,
          quantityPerCase: extractQtyPerCaseFromPackSize(order.packSize),
          mrpPerBottle: parseFloat(order.unitRatePerBottle ?? '0'),
          casesDelivered: order.qtyCasesDelivered ?? 0,
          bottlesDelivered: order.qtyBottlesDelivered ?? 0,
          totalBottles: order.totalBottles ?? 0,
          orderIds: [order.id],
          invoiceDate: order.invoiceDate ?? null,
        });
      }
    }

    let updatedStockCount = 0;
    const today = new Date().toISOString().split('T')[0];
    const syncedOrderIds: number[] = [];

    for (const agg of Array.from(updateAgg.values())) {
      const matchedStock = allStock.find(s => s.id === agg.stockId)!;

      const newCases = (matchedStock.stockInCases ?? 0) + agg.casesDelivered;
      const newBottles = (matchedStock.stockInBottles ?? 0) + agg.bottlesDelivered;
      const newTotalBottles = (matchedStock.totalStockBottles ?? 0) + agg.totalBottles;
      const mrpNum = parseFloat(matchedStock.mrp) || 0;
      const newTotalValue = (newTotalBottles * mrpNum).toFixed(2);

      await db.update(stockDetails)
        .set({
          stockInCases: newCases,
          stockInBottles: newBottles,
          totalStockBottles: newTotalBottles,
          totalStockValue: newTotalValue,
          invoiceDate: agg.invoiceDate ?? today,
          updatedAt: new Date(),
        })
        .where(eq(stockDetails.id, matchedStock.id));

      updatedStockCount++;
      syncedOrderIds.push(...agg.orderIds);
    }

    for (const agg of Array.from(createAgg.values())) {
      const mrpEstimate = agg.mrpPerBottle > 0 ? agg.mrpPerBottle : 0;
      const totalValue = (agg.totalBottles * mrpEstimate).toFixed(2);

      await db.insert(stockDetails).values({
        brandNumber: agg.brandNumber,
        brandName: agg.brandName,
        size: agg.size,
        quantityPerCase: agg.quantityPerCase,
        stockInCases: agg.casesDelivered,
        stockInBottles: agg.bottlesDelivered,
        totalStockBottles: agg.totalBottles,
        mrp: String(mrpEstimate),
        totalStockValue: totalValue,
        breakage: 0,
        invoiceDate: agg.invoiceDate ?? today,
      });

      updatedStockCount++;
      syncedOrderIds.push(...agg.orderIds);
    }

    // Mark all synced orders in one batch query
    if (syncedOrderIds.length > 0) {
      await db.update(orders)
        .set({ dataUpdated: "YES" })
        .where(inArray(orders.id, syncedOrderIds));
    }

    return { syncedOrderIds, updatedStockCount };
  }

  async syncStockToDailySales(): Promise<{ updatedSalesCount: number; createdSalesCount: number }> {
    const allStock = await db.select().from(stockDetails);
    const today = new Date().toISOString().split('T')[0];

    if (allStock.length === 0) {
      return { updatedSalesCount: 0, createdSalesCount: 0 };
    }

    // Only operate on today's date; skip if today is already submitted
    const todaySubmitted = await this.isSalesSubmittedForDate(today);
    if (todaySubmitted) {
      console.log(`syncStockToDailySales: today (${today}) is already submitted, skipping.`);
      return { updatedSalesCount: 0, createdSalesCount: 0 };
    }

    // Only load today's non-submitted sales records
    let todaySales = await db.select().from(dailySales)
      .where(and(eq(dailySales.saleDate, today), eq(dailySales.isSubmitted, false)));

    let updatedSalesCount = 0;
    let createdSalesCount = 0;
    const processedSaleIds = new Set<number>();

    for (const stock of allStock) {
      const normalizedStockSize = stock.size.trim().toLowerCase().replace(/\s+/g, "");

      const matchedSale = todaySales.find(sale => {
        if (processedSaleIds.has(sale.id)) return false;
        if (sale.brandNumber !== stock.brandNumber) return false;
        const saleSize = sale.size.trim().toLowerCase().replace(/\s+/g, "");
        if (normalizedStockSize !== saleSize && !normalizedStockSize.includes(saleSize) && !saleSize.includes(normalizedStockSize)) return false;
        return true;
      });

      if (matchedSale) {
        await db.update(dailySales)
          .set({
            openingBalanceBottles: stock.totalStockBottles ?? 0,
            newStockCases: stock.stockInCases ?? 0,
            newStockBottles: stock.stockInBottles ?? 0,
            invoiceDate: stock.invoiceDate ?? null,
          })
          .where(and(eq(dailySales.id, matchedSale.id), eq(dailySales.isSubmitted, false)));

        processedSaleIds.add(matchedSale.id);
        updatedSalesCount++;
      } else {
        try {
          const [created] = await db.insert(dailySales).values({
            brandNumber: stock.brandNumber,
            brandName: stock.brandName,
            size: stock.size,
            quantityPerCase: stock.quantityPerCase,
            openingBalanceBottles: stock.totalStockBottles ?? 0,
            newStockCases: stock.stockInCases ?? 0,
            newStockBottles: stock.stockInBottles ?? 0,
            closingBalanceCases: 0,
            closingBalanceBottles: 0,
            mrp: stock.mrp || '0',
            totalSaleValue: '0',
            soldBottles: 0,
            saleValue: '0',
            breakageBottles: 0,
            totalClosingStock: 0,
            finalClosingBalance: 0,
            saleDate: today,
            invoiceDate: stock.invoiceDate ?? null,
          }).onConflictDoUpdate({
            target: [dailySales.brandNumber, dailySales.size, dailySales.saleDate],
            set: {
              openingBalanceBottles: stock.totalStockBottles ?? 0,
              newStockCases: stock.stockInCases ?? 0,
              newStockBottles: stock.stockInBottles ?? 0,
              invoiceDate: stock.invoiceDate ?? null,
            },
          }).returning();
          if (created) {
            createdSalesCount++;
            todaySales.push(created);
          }
        } catch (e: any) {
          console.log(`Skipping daily_sales insert for brand ${stock.brandNumber} size ${stock.size}: ${e.message}`);
        }
      }
    }

    return { updatedSalesCount, createdSalesCount };
  }

  async syncDailySalesToStock(date?: string): Promise<{ updatedStockCount: number }> {
    // Sync any date's saved daily_sales to stock_details.
    // Logic: SET stock values to closing-stock values from daily_sales (upsert).
    //   - If a matching stock_details row exists → UPDATE (SET, not decrease)
    //   - If no match → INSERT a new stock_details row
    // This keeps stock_details up to date with the most recently saved sales.
    const targetDate = date || new Date().toISOString().split('T')[0];

    const dateSales = await db.select().from(dailySales).where(eq(dailySales.saleDate, targetDate));
    if (dateSales.length === 0) {
      console.log(`[syncDailySalesToStock] No sales for ${targetDate}, skipping`);
      return { updatedStockCount: 0 };
    }

    const allStock = await db.select().from(stockDetails);
    console.log(`[syncDailySalesToStock] date=${targetDate} sales=${dateSales.length} stockRows=${allStock.length}`);

    const normStr = (s: string) => (s ?? '').trim().toLowerCase().replace(/\s+/g, "");
    const sizeMatch = (a: string, b: string) => {
      const na = normStr(a), nb = normStr(b);
      return na === nb || na.includes(nb) || nb.includes(na);
    };

    // Separate matched vs unmatched in JS (matching logic is fuzzy — can't easily batch in SQL)
    type UpdateRow = { id: number; qty: number; cases: number; btls: number; totBtls: number; totVal: string; mrpStr: string };
    type InsertRow = { brandNumber: string; brandName: string; size: string; quantityPerCase: number; stockInCases: number; stockInBottles: number; totalStockBottles: number; mrp: string; totalStockValue: string };
    const updateRows: UpdateRow[] = [];
    const insertRows: InsertRow[] = [];

    for (const sale of dateSales) {
      let matchedStock = allStock.find(stock =>
        sale.brandNumber === stock.brandNumber &&
        normStr(sale.brandName) === normStr(stock.brandName) &&
        sizeMatch(sale.size, stock.size ?? '') &&
        (sale.quantityPerCase ?? 0) === (stock.quantityPerCase ?? 0)
      );
      if (!matchedStock) {
        matchedStock = allStock.find(stock =>
          sale.brandNumber === stock.brandNumber &&
          normStr(sale.brandName) === normStr(stock.brandName) &&
          sizeMatch(sale.size, stock.size ?? '')
        );
      }
      // (no per-brand log — summary printed at end)

      const saleMrp = parseFloat(String(sale.mrp ?? '0')) || 0;
      const totalBottles = sale.totalClosingStock ?? 0;

      // For untouched rows (no closing entered), closingBalanceCases & closingBalanceBottles
      // are stored as 0 but totalClosingStock = opening + new stock (all carried forward).
      // Derive cases/bottles from totalClosingStock so stock_details stays consistent.
      const rawCases = sale.closingBalanceCases ?? 0;
      const rawBtls  = sale.closingBalanceBottles ?? 0;
      const qtyPc    = (sale.quantityPerCase && sale.quantityPerCase > 0) ? sale.quantityPerCase : 12;
      const isUntouched = rawCases === 0 && rawBtls === 0 && totalBottles > 0;
      const effectiveCases = isUntouched ? Math.floor(totalBottles / qtyPc) : rawCases;
      const effectiveBtls  = isUntouched ? (totalBottles % qtyPc)           : rawBtls;

      if (matchedStock) {
        const existingMrp = parseFloat(String(matchedStock.mrp ?? '0')) || 0;
        const newMrp = saleMrp > 0 ? saleMrp : existingMrp;
        const newQty = qtyPc;
        updateRows.push({
          id: matchedStock.id,
          qty: newQty,
          cases: effectiveCases,
          btls: effectiveBtls,
          totBtls: totalBottles,
          totVal: (totalBottles * newMrp).toFixed(2),
          mrpStr: newMrp.toString(),
        });
      } else {
        insertRows.push({
          brandNumber: sale.brandNumber,
          brandName: sale.brandName,
          size: sale.size,
          quantityPerCase: qtyPc,
          stockInCases: effectiveCases,
          stockInBottles: effectiveBtls,
          totalStockBottles: totalBottles,
          mrp: saleMrp > 0 ? saleMrp.toString() : '0',
          totalStockValue: (totalBottles * saleMrp).toFixed(2),
        });
      }
    }

    // Batch UPDATE using raw SQL VALUES clause (single round-trip)
    if (updateRows.length > 0) {
      const placeholders = updateRows.map((_, i) =>
        `($${i * 7 + 1}::int, $${i * 7 + 2}::int, $${i * 7 + 3}::int, $${i * 7 + 4}::int, $${i * 7 + 5}::int, $${i * 7 + 6}::numeric, $${i * 7 + 7}::numeric)`
      ).join(', ');
      const params = updateRows.flatMap(u => [u.id, u.qty, u.cases, u.btls, u.totBtls, u.totVal, u.mrpStr]);
      await pool.query(
        `UPDATE stock_details sd
         SET quantity_per_case = v.qty, stock_in_cases = v.cases, stock_in_bottles = v.btls,
             total_stock_bottles = v.tot_btls, total_stock_value = v.tot_val, mrp = v.mrp
         FROM (VALUES ${placeholders}) AS v(id, qty, cases, btls, tot_btls, tot_val, mrp)
         WHERE sd.id = v.id`,
        params
      );
    }

    // Batch INSERT for new rows
    if (insertRows.length > 0) {
      await db.insert(stockDetails).values(insertRows);
    }

    const updatedStockCount = updateRows.length + insertRows.length;
    console.log(`[syncDailySalesToStock] Done. Updated ${updateRows.length} + inserted ${insertRows.length} stock rows`);
    _invalidate('stockDetails');
    return { updatedStockCount };
  }

  async getDailyStockByDate(date: string): Promise<DailyStock[]> {
    return await db.select().from(dailyStock).where(eq(dailyStock.date, date));
  }

  async getAvailableStockDates(): Promise<string[]> {
    const result = await db
      .selectDistinct({ date: dailyStock.date })
      .from(dailyStock)
      .where(sql`${dailyStock.date} IS NOT NULL`)
      .orderBy(asc(dailyStock.date));
    return result.map(r => r.date).filter(Boolean) as string[];
  }

  async getMostRecentDailyStockBefore(date: string): Promise<DailyStock[]> {
    const rows = await db
      .select()
      .from(dailyStock)
      .where(lt(dailyStock.date, date))
      .orderBy(desc(dailyStock.date))
      .limit(200);
    if (rows.length === 0) return [];
    const mostRecentDate = rows[0].date;
    return rows.filter((r) => r.date === mostRecentDate);
  }

  async upsertDailyStockSnapshot(date: string): Promise<void> {
    const dateSales = await db.select().from(dailySales).where(eq(dailySales.saleDate, date));
    if (dateSales.length === 0) return;
    // Batch upsert — single INSERT ... ON CONFLICT instead of N individual queries
    await db.insert(dailyStock)
      .values(dateSales.map(sale => ({
        brandNumber: sale.brandNumber,
        brandName: sale.brandName,
        size: sale.size,
        quantityPerCase: sale.quantityPerCase,
        stockInCases: sale.closingBalanceCases ?? 0,
        stockInBottles: sale.closingBalanceBottles ?? 0,
        totalStockBottles: sale.totalClosingStock ?? 0,
        mrp: sale.mrp || '0',
        totalStockValue: ((sale.totalClosingStock ?? 0) * parseFloat(String(sale.mrp || '0'))).toFixed(2),
        breakage: sale.breakageBottles ?? 0,
        date: date,
      })))
      .onConflictDoUpdate({
        target: [dailyStock.brandNumber, dailyStock.size, dailyStock.date],
        set: {
          quantityPerCase: sql`excluded.quantity_per_case`,
          stockInCases: sql`excluded.stock_in_cases`,
          stockInBottles: sql`excluded.stock_in_bottles`,
          totalStockBottles: sql`excluded.total_stock_bottles`,
          mrp: sql`excluded.mrp`,
          totalStockValue: sql`excluded.total_stock_value`,
          breakage: sql`excluded.breakage`,
        },
      });
  }

  async replaceFullDailyStockSnapshot(date: string): Promise<void> {
    // Full replace: delete all existing rows for this date, then insert fresh from daily_sales.
    // This ensures deleted sales rows are also removed from the daily_stock snapshot.
    const dateSales = await db.select().from(dailySales).where(eq(dailySales.saleDate, date));

    // Delete ALL existing snapshot rows for this date
    await db.delete(dailyStock).where(eq(dailyStock.date, date));

    if (dateSales.length === 0) return;

    // Re-insert from current daily_sales state
    await db.insert(dailyStock).values(dateSales.map(sale => ({
      brandNumber: sale.brandNumber,
      brandName: sale.brandName,
      size: sale.size,
      quantityPerCase: sale.quantityPerCase,
      stockInCases: sale.closingBalanceCases ?? 0,
      stockInBottles: sale.closingBalanceBottles ?? 0,
      totalStockBottles: sale.totalClosingStock ?? 0,
      mrp: sale.mrp || '0',
      totalStockValue: ((sale.totalClosingStock ?? 0) * parseFloat(String(sale.mrp || '0'))).toFixed(2),
      breakage: sale.breakageBottles ?? 0,
      date: date,
    })));
  }

  async getSalesMrpDetails(): Promise<SalesMrpDetail[]> {
    const cached = _getCache<SalesMrpDetail[]>('salesMrp');
    if (cached) return cached;
    const result = await db.select().from(salesMrpDetails).orderBy(brandNumberOrder);
    return _setCache('salesMrp', result, 120_000); // 2 minute TTL
  }

  async upsertSalesMrpDetail(data: InsertSalesMrpDetail): Promise<SalesMrpDetail> {
    const [result] = await db.insert(salesMrpDetails).values(data).onConflictDoUpdate({
      target: [salesMrpDetails.brandNumber, salesMrpDetails.brandName, salesMrpDetails.size, salesMrpDetails.productType],
      set: {
        salesMrp: data.salesMrp,
        updatedAt: new Date(),
      },
    }).returning();
    _invalidate('salesMrp');
    return result;
  }

  async bulkUpsertSalesMrpDetails(data: InsertSalesMrpDetail[]): Promise<number> {
    if (data.length === 0) return 0;
    const results = await db.insert(salesMrpDetails).values(data).onConflictDoUpdate({
      target: [salesMrpDetails.brandNumber, salesMrpDetails.brandName, salesMrpDetails.size, salesMrpDetails.productType],
      set: {
        salesMrp: sql`excluded.sales_mrp`,
        updatedAt: new Date(),
      },
    }).returning();
    _invalidate('salesMrp');
    return results.length;
  }

  async deleteSalesMrpDetail(id: number): Promise<boolean> {
    const result = await db.delete(salesMrpDetails).where(eq(salesMrpDetails.id, id)).returning();
    _invalidate('salesMrp');
    return result.length > 0;
  }

  async createShopDetail(shop: InsertShopDetail): Promise<ShopDetail> {
    const [created] = await db.insert(shopDetails).values(shop).returning();
    return created;
  }

  async getShopDetails(): Promise<ShopDetail[]> {
    return await db.select().from(shopDetails).orderBy(desc(shopDetails.id));
  }

  async getShopDetailByLicenseNo(licenseNo: string): Promise<ShopDetail | undefined> {
    const [detail] = await db.select().from(shopDetails).where(eq(shopDetails.licenseNo, licenseNo)).limit(1);
    return detail;
  }

  async getShopDetailByIcdcNumber(icdcNumber: string): Promise<ShopDetail | undefined> {
    const [detail] = await db.select().from(shopDetails).where(eq(shopDetails.icdcNumber, icdcNumber)).limit(1);
    return detail;
  }

  // Expense Categories
  async getExpenseCategories(type?: string): Promise<ExpenseCategory[]> {
    if (type) {
      return await db.select().from(expenseCategories).where(eq(expenseCategories.type, type)).orderBy(asc(expenseCategories.name));
    }
    return await db.select().from(expenseCategories).orderBy(asc(expenseCategories.type), asc(expenseCategories.name));
  }

  async createExpenseCategory(data: InsertExpenseCategory): Promise<ExpenseCategory> {
    const [created] = await db.insert(expenseCategories).values(data).returning();
    return created;
  }

  async deleteExpenseCategory(id: number): Promise<boolean> {
    const result = await db.delete(expenseCategories).where(eq(expenseCategories.id, id)).returning();
    return result.length > 0;
  }

  // Daily Expenses
  async getDailyExpenses(date: string): Promise<DailyExpense[]> {
    return await db.select().from(dailyExpenses).where(eq(dailyExpenses.date, date)).orderBy(asc(dailyExpenses.createdAt));
  }

  async createDailyExpense(data: InsertDailyExpense): Promise<DailyExpense> {
    const [created] = await db.insert(dailyExpenses).values(data).returning();
    return created;
  }

  async updateDailyExpense(id: number, data: Partial<InsertDailyExpense>): Promise<DailyExpense> {
    const [updated] = await db.update(dailyExpenses).set(data).where(eq(dailyExpenses.id, id)).returning();
    return updated;
  }

  async deleteDailyExpense(id: number): Promise<boolean> {
    const result = await db.delete(dailyExpenses).where(eq(dailyExpenses.id, id)).returning();
    return result.length > 0;
  }
}

export const storage = new DatabaseStorage();
