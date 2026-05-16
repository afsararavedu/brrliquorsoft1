import { Switch, Route, Redirect, Router as WouterRouter } from "wouter";
import { useState, lazy, Suspense } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { AuthProvider, useAuth } from "@/hooks/use-auth";

// AuthPage and ResetPassword are eagerly loaded — they render before auth
// resolves and must be available instantly with no additional round-trip.
import AuthPage from "@/pages/AuthPage";
import ResetPassword from "@/pages/ResetPassword";

// All protected pages are lazy-loaded so the initial JS bundle only contains
// the auth/shell code. Vite splits each import() into its own chunk and the
// browser fetches only what the current route needs.
const NotFound    = lazy(() => import("@/pages/not-found"));
const Home        = lazy(() => import("@/pages/Home"));
const Sales       = lazy(() => import("@/pages/Sales"));
const Stock       = lazy(() => import("@/pages/Stock"));
const Inventory   = lazy(() => import("@/pages/Inventory"));
const Reports     = lazy(() => import("@/pages/Reports"));
const Expenses    = lazy(() => import("@/pages/Expenses"));
const AboutUs     = lazy(() => import("@/pages/AboutUs"));
const ContactUs   = lazy(() => import("@/pages/ContactUs"));

function ProtectedRoute({ component: Component, path, role }: { component: React.ComponentType, path: string, role?: string }) {
  const { user, isLoading } = useAuth();

  if (isLoading) return <div className="flex items-center justify-center h-screen">Loading...</div>;
  if (!user) return <Redirect to="/auth" />;
  if (role && user.role !== role) return <Redirect to="/sales" />;

  return <Component />;
}

function Router() {
  const { user } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-background font-sans">
      {user && (
        <Sidebar drawerOpen={drawerOpen} onDrawerClose={() => setDrawerOpen(false)} />
      )}
      <div className={`flex-1 min-w-0 ${user ? 'lg:pl-64' : ''} flex flex-col min-h-screen transition-all`}>
        {user && (
          <Header onMenuClick={() => setDrawerOpen(true)} />
        )}
        <main className="flex-1 min-w-0 p-4 md:p-6 lg:p-8 overflow-x-hidden">
          <div className="w-full min-w-0">
            <Suspense fallback={<div className="flex items-center justify-center h-64 text-muted-foreground">Loading…</div>}>
              <Switch>
                <Route path="/auth" component={AuthPage} />
                <Route path="/reset-password" component={ResetPassword} />

                <Route path="/">
                  <ProtectedRoute component={Home} path="/" role="admin" />
                </Route>
                <Route path="/sales">
                  <ProtectedRoute component={Sales} path="/sales" />
                </Route>
                <Route path="/stock">
                  <ProtectedRoute component={Stock} path="/stock" role="admin" />
                </Route>
                <Route path="/inventory">
                  <ProtectedRoute component={Inventory} path="/inventory" />
                </Route>
                <Route path="/expenses">
                  <ProtectedRoute component={Expenses} path="/expenses" />
                </Route>
                <Route path="/reports">
                  <ProtectedRoute component={Reports} path="/reports" role="admin" />
                </Route>

                <Route path="/credits" component={() => <div className="p-12 text-center text-muted-foreground">Credits Module Coming Soon</div>} />
                <Route path="/calendar" component={() => <div className="p-12 text-center text-muted-foreground">Calendar Module Coming Soon</div>} />

                <Route path="/about">
                  <ProtectedRoute component={AboutUs} path="/about" />
                </Route>
                <Route path="/contact">
                  <ProtectedRoute component={ContactUs} path="/contact" />
                </Route>

                <Route component={NotFound} />
              </Switch>
            </Suspense>
          </div>
        </main>
        <footer className="border-t py-3 px-8 text-center text-sm text-muted-foreground" data-testid="footer-copyright">
          <p>&copy; {new Date().getFullYear()} BRR IT Solutions . All rights reserved.</p>
        </footer>
      </div>
    </div>
  );
}

export default function App() {
  return (
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
  );
}
