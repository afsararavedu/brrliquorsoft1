import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { format, parse } from "date-fns";
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  TrendingDown,
  TrendingUp,
  Wallet,
  BarChart3,
  Settings2,
} from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { DailyExpense, ExpenseCategory } from "@shared/schema";

// ── Date helpers (same as Sales page) ────────────────────────────────────────
function getTodayLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function parseDateLocal(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function formatDateLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const PAYMENT_MODES = ["Cash", "UPI", "Bank"] as const;

// ── Summary card ──────────────────────────────────────────────────────────────
function SummaryCard({ label, amount, color, icon }: { label: string; amount: number; color: string; icon: React.ReactNode }) {
  return (
    <div className={`rounded-xl border p-4 flex items-center gap-4 ${color}`}>
      <div className="shrink-0 w-10 h-10 rounded-lg flex items-center justify-center bg-white/60">
        {icon}
      </div>
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{label}</p>
        <p className="text-xl font-bold">₹{amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
      </div>
    </div>
  );
}

export default function Expenses() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { toast } = useToast();

  // ── Date state ──────────────────────────────────────────────────────────────
  const [selectedDate, setSelectedDate] = useState(getTodayLocal());
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  // Earliest invoice date — same floor used by Sales page
  const { data: earliestOrderDateData } = useQuery<{ invoiceDate: string | null }>({
    queryKey: ["/api/orders/earliest-invoice-date"],
  });
  const earliestOrderDate = earliestOrderDateData?.invoiceDate
    ? parse(earliestOrderDateData.invoiceDate, "yyyy-MM-dd", new Date())
    : new Date(2020, 0, 1);
  const earliestOrderDateStr = earliestOrderDateData?.invoiceDate ?? "2020-01-01";

  function goDay(delta: number) {
    const d = parseDateLocal(selectedDate);
    d.setDate(d.getDate() + delta);
    const next = formatDateLocal(d);
    const today = getTodayLocal();
    if (next < earliestOrderDateStr || next > today) return;
    setSelectedDate(next);
  }

  // ── Form state ──────────────────────────────────────────────────────────────
  const [formType, setFormType] = useState<"expense" | "income">("expense");
  const [formCategory, setFormCategory] = useState("");
  const [formAmount, setFormAmount] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formPaymentMode, setFormPaymentMode] = useState<"Cash" | "UPI" | "Bank">("Cash");

  // ── Edit state (admin only) ─────────────────────────────────────────────────
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editData, setEditData] = useState<Partial<DailyExpense>>({});
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  // ── Manage categories (admin only) ──────────────────────────────────────────
  const [newCatExpense, setNewCatExpense] = useState("");
  const [newCatIncome, setNewCatIncome] = useState("");

  // ── Queries ─────────────────────────────────────────────────────────────────
  const { data: categories = [] } = useQuery<ExpenseCategory[]>({
    queryKey: ["/api/expense-categories"],
  });

  const { data: expenses = [], isLoading: expensesLoading } = useQuery<DailyExpense[]>({
    queryKey: ["/api/daily-expenses", selectedDate],
    queryFn: () => fetch(`/api/daily-expenses?date=${selectedDate}`, { credentials: "include" }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
  });

  const { data: salesData = [] } = useQuery<any[]>({
    queryKey: ["/api/sales", selectedDate],
    queryFn: () => fetch(`/api/sales?date=${selectedDate}`, { credentials: "include" }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
  });

  // ── Derived summary values ──────────────────────────────────────────────────
  const expenseCategories = categories.filter(c => c.type === "expense");
  const incomeCategories = categories.filter(c => c.type === "income");
  const filteredCategories = formType === "expense" ? expenseCategories : incomeCategories;

  const salesTotal = salesData.reduce((sum: number, s: any) => sum + (parseFloat(s.totalSaleValue) || 0), 0);
  const expensesTotal = expenses.filter(e => e.type === "expense").reduce((sum, e) => sum + parseFloat(e.amount as string), 0);
  const incomeTotal = expenses.filter(e => e.type === "income").reduce((sum, e) => sum + parseFloat(e.amount as string), 0);
  const net = salesTotal - expensesTotal + incomeTotal;

  // Reset category when type changes
  useEffect(() => { setFormCategory(""); }, [formType]);

  // ── Mutations ────────────────────────────────────────────────────────────────
  const addExpense = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/daily-expenses", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/daily-expenses", selectedDate] });
      setFormAmount("");
      setFormDescription("");
      toast({ title: "Entry added", className: "bg-green-50 text-green-800" });
    },
    onError: (err: any) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const updateExpense = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => apiRequest("PUT", `/api/daily-expenses/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/daily-expenses", selectedDate] });
      setEditingId(null);
      toast({ title: "Updated", className: "bg-green-50 text-green-800" });
    },
    onError: (err: any) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const deleteExpense = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/daily-expenses/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/daily-expenses", selectedDate] });
      setDeleteConfirmId(null);
      toast({ title: "Deleted", className: "bg-red-50 text-red-800" });
    },
    onError: (err: any) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const addCategory = useMutation({
    mutationFn: (data: { name: string; type: string }) =>
      apiRequest("POST", "/api/expense-categories", data),
    onSuccess: (_res, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/expense-categories"] });
      setNewCatExpense("");
      setNewCatIncome("");
      toast({
        title: "Category added",
        description: `"${variables.name}" added to ${variables.type} categories.`,
        className: "bg-green-50 text-green-800",
      });
    },
    onError: (err: any) => toast({ title: "Failed to add category", description: err.message, variant: "destructive" }),
  });

  const deleteCategory = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/expense-categories/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/expense-categories"] }),
    onError: (err: any) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formCategory) { toast({ title: "Select a category", variant: "destructive" }); return; }
    const amt = parseFloat(formAmount);
    if (isNaN(amt) || amt <= 0) { toast({ title: "Enter a valid amount", variant: "destructive" }); return; }
    addExpense.mutate({ date: selectedDate, type: formType, category: formCategory, amount: amt, description: formDescription || null, paymentMode: formPaymentMode });
  }

  function startEdit(e: DailyExpense) {
    setEditingId(e.id);
    setEditData({ type: e.type as any, category: e.category, amount: e.amount as any, description: e.description ?? "", paymentMode: e.paymentMode as any });
  }

  function saveEdit() {
    if (!editingId) return;
    updateExpense.mutate({ id: editingId, data: editData });
  }

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Expenses & Income</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Track daily expenses and additional income</p>
        </div>

        {/* Date Picker — floored at earliest invoice date, same as Sales page */}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            onClick={() => goDay(-1)}
            disabled={selectedDate <= earliestOrderDateStr}
            data-testid="button-prev-day"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" className="min-w-[160px] justify-start gap-2" data-testid="button-date-picker">
                <CalendarIcon className="h-4 w-4 text-muted-foreground" />
                {format(parseDateLocal(selectedDate), "dd-MM-yyyy")}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="single"
                selected={parseDateLocal(selectedDate)}
                onSelect={(d) => { if (d) { setSelectedDate(formatDateLocal(d)); setDatePickerOpen(false); } }}
                fromDate={earliestOrderDate}
                toDate={new Date()}
                disabled={(date) => {
                  const floor = new Date(earliestOrderDate);
                  floor.setHours(0, 0, 0, 0);
                  if (date < floor) return true;
                  const today = new Date();
                  today.setHours(23, 59, 59, 999);
                  return date > today;
                }}
                initialFocus
              />
            </PopoverContent>
          </Popover>
          <Button
            variant="outline"
            size="icon"
            onClick={() => goDay(1)}
            disabled={selectedDate >= getTodayLocal()}
            data-testid="button-next-day"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* ── Summary Cards ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <SummaryCard label="Sales Total" amount={salesTotal} color="bg-blue-50 border-blue-100" icon={<BarChart3 className="w-5 h-5 text-blue-600" />} />
        <SummaryCard label="Expenses Total" amount={expensesTotal} color="bg-red-50 border-red-100" icon={<TrendingDown className="w-5 h-5 text-red-600" />} />
        <SummaryCard label="Income Total" amount={incomeTotal} color="bg-green-50 border-green-100" icon={<TrendingUp className="w-5 h-5 text-green-600" />} />
        <SummaryCard label="Net Balance" amount={net} color={net >= 0 ? "bg-emerald-50 border-emerald-100" : "bg-orange-50 border-orange-100"} icon={<Wallet className={`w-5 h-5 ${net >= 0 ? "text-emerald-600" : "text-orange-600"}`} />} />
      </div>

      <Tabs defaultValue="entries">
        <TabsList>
          <TabsTrigger value="entries" data-testid="tab-entries">Entries</TabsTrigger>
          {isAdmin && <TabsTrigger value="categories" data-testid="tab-categories"><Settings2 className="w-3.5 h-3.5 mr-1" />Manage Categories</TabsTrigger>}
        </TabsList>

        {/* ── Entries Tab ── */}
        <TabsContent value="entries" className="space-y-5 mt-4">

          {/* Add Entry Form */}
          <div className="border rounded-xl p-5 bg-card space-y-4">
            {/* Form header: title on the left, Expense/Income toggle on the right */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Add New Entry</h2>
              <div className="flex items-center gap-1.5" data-testid="type-toggle-group">
                <button
                  type="button"
                  onClick={() => { setFormType("expense"); setFormCategory(""); }}
                  data-testid="button-type-expense"
                  className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold border transition-all ${
                    formType === "expense"
                      ? "bg-red-500 border-red-500 text-white shadow-sm"
                      : "bg-card border-border text-muted-foreground hover:border-red-300 hover:text-red-600"
                  }`}
                >
                  <TrendingDown className="w-3.5 h-3.5" />
                  Expense
                </button>
                <button
                  type="button"
                  onClick={() => { setFormType("income"); setFormCategory(""); }}
                  data-testid="button-type-income"
                  className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold border transition-all ${
                    formType === "income"
                      ? "bg-green-500 border-green-500 text-white shadow-sm"
                      : "bg-card border-border text-muted-foreground hover:border-green-300 hover:text-green-600"
                  }`}
                >
                  <TrendingUp className="w-3.5 h-3.5" />
                  Income
                </button>
              </div>
            </div>
            <form onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3 items-end">

              {/* Category */}
              <div className="space-y-1">
                <Label className="text-xs">Category</Label>
                <Select value={formCategory || "__none__"} onValueChange={v => setFormCategory(v === "__none__" ? "" : v)} data-testid="select-entry-category">
                  <SelectTrigger className="h-9" data-testid="select-entry-category">
                    <SelectValue placeholder="Select category…" />
                  </SelectTrigger>
                  <SelectContent>
                    {filteredCategories.length === 0 && (
                      <SelectItem value="__none__" disabled>No categories yet</SelectItem>
                    )}
                    {filteredCategories.map(c => (
                      <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Amount */}
              <div className="space-y-1">
                <Label className="text-xs">Amount (₹)</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={formAmount}
                  onChange={e => setFormAmount(e.target.value)}
                  data-testid="input-entry-amount"
                />
              </div>

              {/* Payment Mode */}
              <div className="space-y-1">
                <Label className="text-xs">Payment Mode</Label>
                <Select value={formPaymentMode} onValueChange={v => setFormPaymentMode(v as any)} data-testid="select-payment-mode">
                  <SelectTrigger className="h-9" data-testid="select-payment-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_MODES.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              {/* Description */}
              <div className="space-y-1">
                <Label className="text-xs">Description (optional)</Label>
                <Input
                  placeholder="Notes…"
                  value={formDescription}
                  onChange={e => setFormDescription(e.target.value)}
                  data-testid="input-entry-description"
                />
              </div>

              {/* Submit */}
              <div className="space-y-1">
                <Label className="text-xs invisible">Submit</Label>
                <Button type="submit" className="w-full" disabled={addExpense.isPending} data-testid="button-add-entry">
                  <Plus className="w-4 h-4 mr-1" />
                  {addExpense.isPending ? "Adding…" : "Add Entry"}
                </Button>
              </div>
            </form>
          </div>

          {/* Entries Table */}
          <div className="border rounded-xl overflow-hidden bg-card">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50 border-b">
                    <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Type</th>
                    <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Category</th>
                    <th className="text-right px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Amount</th>
                    <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Mode</th>
                    <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Description</th>
                    <th className="text-left px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Submitted By</th>
                    {isAdmin && <th className="text-center px-4 py-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {expensesLoading && (
                    <tr><td colSpan={isAdmin ? 7 : 6} className="text-center py-10 text-muted-foreground">Loading…</td></tr>
                  )}
                  {!expensesLoading && expenses.length === 0 && (
                    <tr><td colSpan={isAdmin ? 7 : 6} className="text-center py-10 text-muted-foreground">No entries for this date yet.</td></tr>
                  )}
                  {expenses.map(entry => {
                    const isEditing = editingId === entry.id;
                    const isConfirmDelete = deleteConfirmId === entry.id;
                    const isExpense = (isEditing ? editData.type : entry.type) === "expense";

                    return (
                      <tr
                        key={entry.id}
                        data-testid={`row-expense-${entry.id}`}
                        className={`border-b last:border-0 transition-colors ${isEditing ? "bg-yellow-50" : "hover:bg-muted/30"}`}
                      >
                        {/* Type */}
                        <td className="px-4 py-2.5">
                          {isEditing ? (
                            <Select value={editData.type} onValueChange={v => setEditData(p => ({ ...p, type: v as any, category: "" }))}>
                              <SelectTrigger className="h-8 text-sm w-28">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="expense">Expense</SelectItem>
                                <SelectItem value="income">Income</SelectItem>
                              </SelectContent>
                            </Select>
                          ) : (
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${entry.type === "expense" ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
                              {entry.type === "expense" ? <TrendingDown className="w-3 h-3" /> : <TrendingUp className="w-3 h-3" />}
                              {entry.type === "expense" ? "Expense" : "Income"}
                            </span>
                          )}
                        </td>

                        {/* Category */}
                        <td className="px-4 py-2.5">
                          {isEditing ? (
                            <Select value={editData.category || "__none__"} onValueChange={v => setEditData(p => ({ ...p, category: v === "__none__" ? "" : v }))}>
                              <SelectTrigger className="h-8 text-sm w-36">
                                <SelectValue placeholder="Select…" />
                              </SelectTrigger>
                              <SelectContent>
                                {(isExpense ? expenseCategories : incomeCategories).map(c => (
                                  <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <span className="font-medium">{entry.category}</span>
                          )}
                        </td>

                        {/* Amount */}
                        <td className="px-4 py-2.5 text-right font-mono">
                          {isEditing ? (
                            <Input
                              type="number"
                              min="0"
                              step="0.01"
                              value={editData.amount as any}
                              onChange={e => setEditData(p => ({ ...p, amount: e.target.value as any }))}
                              className="h-8 w-28 text-right ml-auto"
                            />
                          ) : (
                            <span className={entry.type === "expense" ? "text-red-600" : "text-green-600"}>
                              {entry.type === "expense" ? "-" : "+"}₹{parseFloat(entry.amount as string).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                            </span>
                          )}
                        </td>

                        {/* Payment Mode */}
                        <td className="px-4 py-2.5">
                          {isEditing ? (
                            <Select value={editData.paymentMode} onValueChange={v => setEditData(p => ({ ...p, paymentMode: v as any }))}>
                              <SelectTrigger className="h-8 text-sm w-24">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {PAYMENT_MODES.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          ) : (
                            <span className="px-2 py-0.5 rounded bg-muted text-xs font-medium">{entry.paymentMode}</span>
                          )}
                        </td>

                        {/* Description */}
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {isEditing ? (
                            <Input
                              value={editData.description ?? ""}
                              onChange={e => setEditData(p => ({ ...p, description: e.target.value }))}
                              className="h-8"
                              placeholder="Notes…"
                            />
                          ) : (
                            entry.description || <span className="text-muted-foreground/50 italic">—</span>
                          )}
                        </td>

                        {/* Submitted By */}
                        <td className="px-4 py-2.5 text-muted-foreground text-xs">{entry.submittedBy}</td>

                        {/* Actions (admin only) */}
                        {isAdmin && (
                          <td className="px-4 py-2.5">
                            <div className="flex items-center justify-center gap-1">
                              {isEditing ? (
                                <>
                                  <Button size="icon" variant="ghost" className="h-7 w-7 text-green-600 hover:text-green-700 hover:bg-green-50" onClick={saveEdit} disabled={updateExpense.isPending} data-testid={`button-save-edit-${entry.id}`}>
                                    <Check className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" onClick={() => setEditingId(null)} data-testid={`button-cancel-edit-${entry.id}`}>
                                    <X className="w-3.5 h-3.5" />
                                  </Button>
                                </>
                              ) : isConfirmDelete ? (
                                <>
                                  <span className="text-xs text-red-600 mr-1">Sure?</span>
                                  <Button size="icon" variant="ghost" className="h-7 w-7 text-red-600 hover:text-red-700 hover:bg-red-50" onClick={() => deleteExpense.mutate(entry.id)} disabled={deleteExpense.isPending} data-testid={`button-confirm-delete-${entry.id}`}>
                                    <Check className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" onClick={() => setDeleteConfirmId(null)} data-testid={`button-cancel-delete-${entry.id}`}>
                                    <X className="w-3.5 h-3.5" />
                                  </Button>
                                </>
                              ) : (
                                <>
                                  <Button size="icon" variant="ghost" className="h-7 w-7 text-blue-500 hover:text-blue-700 hover:bg-blue-50" onClick={() => startEdit(entry)} data-testid={`button-edit-${entry.id}`}>
                                    <Pencil className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button size="icon" variant="ghost" className="h-7 w-7 text-red-400 hover:text-red-600 hover:bg-red-50" onClick={() => setDeleteConfirmId(entry.id)} data-testid={`button-delete-${entry.id}`}>
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </Button>
                                </>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
                {expenses.length > 0 && (
                  <tfoot className="bg-muted/40 border-t">
                    <tr>
                      <td colSpan={2} className="px-4 py-2.5 font-semibold text-sm">Totals</td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold text-sm">
                        <div className="text-red-600 text-xs">-₹{expensesTotal.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</div>
                        <div className="text-green-600 text-xs">+₹{incomeTotal.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</div>
                      </td>
                      <td colSpan={isAdmin ? 4 : 3} />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </TabsContent>

        {/* ── Manage Categories Tab (admin only) ── */}
        {isAdmin && (
          <TabsContent value="categories" className="mt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

              {/* Expense categories */}
              <div className="border rounded-xl p-5 bg-card space-y-4">
                <h3 className="font-semibold flex items-center gap-2 text-red-600">
                  <TrendingDown className="w-4 h-4" /> Expense Categories
                  <span className="ml-auto text-xs font-normal text-muted-foreground">{expenseCategories.length} item{expenseCategories.length !== 1 ? "s" : ""}</span>
                </h3>

                {/* Add input */}
                <div className="flex gap-2">
                  <Input
                    placeholder="Type a category name and press + or Enter"
                    value={newCatExpense}
                    onChange={e => setNewCatExpense(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); if (newCatExpense.trim()) addCategory.mutate({ name: newCatExpense.trim(), type: "expense" }); } }}
                    data-testid="input-new-expense-category"
                  />
                  <Button
                    onClick={() => { if (newCatExpense.trim()) addCategory.mutate({ name: newCatExpense.trim(), type: "expense" }); }}
                    disabled={!newCatExpense.trim() || addCategory.isPending}
                    size="sm"
                    data-testid="button-add-expense-category"
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>

                {/* Category chips — always fully visible, no scroll */}
                {expenseCategories.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">No expense categories yet. Add one above.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {expenseCategories.map(c => (
                      <div
                        key={c.id}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-50 border border-red-200 text-red-800 text-sm font-medium"
                        data-testid={`item-expense-category-${c.id}`}
                      >
                        {c.name}
                        <button
                          onClick={() => deleteCategory.mutate(c.id)}
                          className="ml-0.5 rounded-full p-0.5 hover:bg-red-200 transition-colors"
                          title="Remove"
                          data-testid={`button-delete-category-${c.id}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Income categories */}
              <div className="border rounded-xl p-5 bg-card space-y-4">
                <h3 className="font-semibold flex items-center gap-2 text-green-600">
                  <TrendingUp className="w-4 h-4" /> Income Categories
                  <span className="ml-auto text-xs font-normal text-muted-foreground">{incomeCategories.length} item{incomeCategories.length !== 1 ? "s" : ""}</span>
                </h3>

                {/* Add input */}
                <div className="flex gap-2">
                  <Input
                    placeholder="Type a category name and press + or Enter"
                    value={newCatIncome}
                    onChange={e => setNewCatIncome(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); if (newCatIncome.trim()) addCategory.mutate({ name: newCatIncome.trim(), type: "income" }); } }}
                    data-testid="input-new-income-category"
                  />
                  <Button
                    onClick={() => { if (newCatIncome.trim()) addCategory.mutate({ name: newCatIncome.trim(), type: "income" }); }}
                    disabled={!newCatIncome.trim() || addCategory.isPending}
                    size="sm"
                    data-testid="button-add-income-category"
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>

                {/* Category chips — always fully visible, no scroll */}
                {incomeCategories.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">No income categories yet. Add one above.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {incomeCategories.map(c => (
                      <div
                        key={c.id}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-green-50 border border-green-200 text-green-800 text-sm font-medium"
                        data-testid={`item-income-category-${c.id}`}
                      >
                        {c.name}
                        <button
                          onClick={() => deleteCategory.mutate(c.id)}
                          className="ml-0.5 rounded-full p-0.5 hover:bg-green-200 transition-colors"
                          title="Remove"
                          data-testid={`button-delete-category-${c.id}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
