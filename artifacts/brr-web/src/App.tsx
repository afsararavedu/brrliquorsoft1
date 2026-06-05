import { Switch, Route, Redirect, Router as WouterRouter, useLocation } from "wouter";
import { useState, lazy, Suspense } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { ErrorBoundary } from "@/components/ErrorBoundary";

import AuthPage from "@/pages/AuthPage";
import ResetPassword from "@/pages/ResetPassword";
import ShopSelectPage from "@/pages/ShopSelectPage";

const NotFound    = lazy(() => import("@/pages/not-found"));
const Home        = lazy(() => import("@/pages/Home"));
const Sales       = lazy(() => import("@/pages/Sales"));
const Stock       = lazy(() => import("@/pages/Stock"));
const Inventory   = lazy(() => import("@/pages/Inventory"));
const Reports     = lazy(() => import("@/pages/Reports"));
const Expenses    = lazy(() => import("@/pages/Expenses"));
const AboutUs     = lazy(() => import("@/pages/AboutUs"));
const ContactUs   = lazy(() => import("@/pages/ContactUs"));

function ProtectedRoute({
  component: Component,
  role,
}: {
  component: React.ComponentType;
  role?: string;
}) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <div className="flex items-center justify-center h-screen">Loading...</div>;
  if (!user) return <Redirect to="/" />;
  if (role && user.role !== role) return <Redirect to="/sales" />;
  return <Component />;
}

function AppShell({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-background font-sans">
      {user && (
        <Sidebar drawerOpen={drawerOpen} onDrawerClose={() => setDrawerOpen(false)} />
      )}
      <div className={`flex-1 min-w-0 ${user ? "lg:pl-64" : ""} flex flex-col min-h-screen transition-all`}>
        {user && <Header onMenuClick={() => setDrawerOpen(true)} />}
        <main className="flex-1 min-w-0 p-4 md:p-6 lg:p-8 overflow-x-hidden">
          <div className="w-full min-w-0">
            <Suspense fallback={<div className="flex items-center justify-center h-64 text-muted-foreground">Loading…</div>}>
              {children}
            </Suspense>
          </div>
        </main>
        <footer
          className="border-t py-3 px-8 text-center text-sm text-muted-foreground"
          data-testid="footer-copyright"
        >
          <p>&copy; {new Date().getFullYear()} BRR IT Solutions . All rights reserved.</p>
        </footer>
      </div>
    </div>
  );
}

function Router() {
  const [location] = useLocation();

  // Public full-screen routes — no sidebar / header / padding
  const isPublicRoute =
    location === "/" ||
    location.startsWith("/login") ||
    location.startsWith("/reset-password");

  if (isPublicRoute) {
    return (
      <Switch>
        <Route path="/" component={ShopSelectPage} />
        <Route path="/login" component={AuthPage} />
        <Route path="/reset-password" component={ResetPassword} />
        {/* legacy /auth alias */}
        <Route path="/auth">
          <Redirect to="/" />
        </Route>
      </Switch>
    );
  }

  return (
    <AppShell>
      <Switch>
        <Route path="/home">
          <ProtectedRoute component={Home} role="admin" />
        </Route>
        <Route path="/sales">
          <ProtectedRoute component={Sales} />
        </Route>
        <Route path="/stock">
          <ProtectedRoute component={Stock} role="admin" />
        </Route>
        <Route path="/inventory">
          <ProtectedRoute component={Inventory} />
        </Route>
        <Route path="/expenses">
          <ProtectedRoute component={Expenses} />
        </Route>
        <Route path="/reports">
          <ProtectedRoute component={Reports} role="admin" />
        </Route>

        <Route path="/credits" component={() => <div className="p-12 text-center text-muted-foreground">Credits Module Coming Soon</div>} />
        <Route path="/calendar" component={() => <div className="p-12 text-center text-muted-foreground">Calendar Module Coming Soon</div>} />

        <Route path="/about">
          <ProtectedRoute component={AboutUs} />
        </Route>
        <Route path="/contact">
          <ProtectedRoute component={ContactUs} />
        </Route>

        {/* If someone navigates to old / while logged in → redirect to /home */}
        <Route path="/">
          <Redirect to="/home" />
        </Route>

        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <TooltipProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <Toaster />
              <Router />
            </WouterRouter>
          </TooltipProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
