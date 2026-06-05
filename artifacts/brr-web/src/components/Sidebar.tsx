import brrLogo from "@assets/brr_solution_logo_1776622112650.jpeg";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  ShoppingCart,
  FileText,
  Package,
  BarChart3,
  CreditCard,
  Calendar,
  Receipt,
  LogOut,
  Phone,
  Info,
  KeyRound,
  X
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";

const NAV_ITEMS = [
  { label: "Home", href: "/home", icon: LayoutDashboard, role: "admin" },
  { label: "Sales", href: "/sales", icon: ShoppingCart },
  { label: "Inventory", href: "/inventory", icon: FileText },
  { label: "Stock", href: "/stock", icon: Package, role: "admin" },
  { label: "Expenses", href: "/expenses", icon: Receipt },
  { label: "Reports", href: "/reports", icon: BarChart3, role: "admin" },
  { label: "Credits", href: "/credits", icon: CreditCard, role: "admin" },
  { label: "Calendar", href: "/calendar", icon: Calendar, role: "admin" },
  { label: "About Us", href: "/about", icon: Info },
  { label: "Contact Us", href: "/contact", icon: Phone },
];

interface SidebarProps {
  drawerOpen?: boolean;
  onDrawerClose?: () => void;
}

export function Sidebar({ drawerOpen = false, onDrawerClose }: SidebarProps) {
  const [location] = useLocation();
  const { user, logoutMutation } = useAuth();

  const filteredNavItems = NAV_ITEMS.filter(item =>
    !item.role || (user && user.role === item.role)
  );

  const navContent = (
    <>
      <div className="p-5 flex items-center gap-3 border-b border-border/50">
        <img src={brrLogo} alt="BRR IT Solutions" className="w-10 h-10 object-contain rounded-lg flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <h1 className="font-display font-bold text-base text-foreground leading-none truncate">BRR Liquor Soft</h1>
          <p className="text-xs text-muted-foreground font-medium mt-1">
            {user?.role === "admin" ? "Admin" : "Employee"} Portal
          </p>
        </div>
        {onDrawerClose && (
          <button
            onClick={onDrawerClose}
            className="lg:hidden p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground flex-shrink-0"
            aria-label="Close menu"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto py-4 px-3 space-y-0.5">
        {filteredNavItems.map((item) => {
          const isActive = location === item.href || (item.href !== "/home" && location.startsWith(item.href));
          return (
            <Link key={item.href} href={item.href}>
              <div
                onClick={onDrawerClose}
                className={cn(
                  "flex items-center gap-3 px-4 py-3.5 rounded-xl transition-all duration-200 cursor-pointer group",
                  isActive
                    ? "bg-primary/10 text-primary shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <item.icon className={cn(
                  "w-5 h-5 transition-colors flex-shrink-0",
                  isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                )} />
                <span className="font-medium text-sm">{item.label}</span>
                {isActive && (
                  <div className="ml-auto w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                )}
              </div>
            </Link>
          );
        })}
      </div>

      <div className="p-4 border-t border-border/50">
        <div className="px-4 py-2 mb-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Logged in as</p>
          <p className="text-sm font-medium truncate">{user?.username}</p>
        </div>
        <Link href="/reset-password">
          <button
            onClick={() => onDrawerClose?.()}
            data-testid="button-reset-password"
            className="flex items-center gap-3 px-4 py-3 rounded-xl w-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <KeyRound className="w-5 h-5 flex-shrink-0" />
            <span className="font-medium text-sm">Reset Password</span>
          </button>
        </Link>
        <button
          onClick={() => logoutMutation.mutate()}
          className="flex items-center gap-3 px-4 py-3 rounded-xl w-full text-muted-foreground hover:bg-red-50 hover:text-red-600 transition-colors"
        >
          <LogOut className="w-5 h-5 flex-shrink-0" />
          <span className="font-medium text-sm">Logout</span>
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* ── Sidebar: always visible on lg+ (tablet landscape, desktop) ── */}
      <div className="hidden lg:flex flex-col w-64 h-screen bg-card border-r border-border fixed left-0 top-0 z-50 shadow-xl shadow-black/5 select-none">
        {navContent}
      </div>

      {/* ── Drawer (< lg): slide-in overlay for mobile + iPad portrait ── */}
      {drawerOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/40 z-40 lg:hidden"
            onClick={onDrawerClose}
          />
          <div className="fixed left-0 top-0 h-screen w-72 bg-card border-r border-border z-50 shadow-2xl flex flex-col lg:hidden animate-in slide-in-from-left duration-200 select-none">
            {navContent}
          </div>
        </>
      )}
    </>
  );
}
