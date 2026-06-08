import brrLogo from "@assets/brr_solution_logo_1776622112650.jpeg";
import bgImage from "@assets/Liquor-store-inventory-homepage_1_1777047159851.png";
import { useAuth } from "@/hooks/use-auth";
import { ApiError } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useLocation, useSearch } from "wouter";
import { useState, useEffect } from "react";

function formatRemaining(totalSec: number): string {
  if (totalSec <= 0) return "0 seconds";
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes <= 0) {
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  if (seconds === 0) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${minutes} min ${seconds} sec`;
}

const loginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

export default function AuthPage() {
  const { user, loginMutation } = useAuth();
  const [, setLocation] = useLocation();
  const search = useSearch();
  const shopName = new URLSearchParams(search).get("shop") ?? "";

  const [lockoutUntil, setLockoutUntil] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(null);

  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: "", password: "" },
  });

  // If no shop selected, send back to shop selector
  useEffect(() => {
    if (!shopName) {
      setLocation("/");
    }
  }, [shopName]);

  useEffect(() => {
    if (user) {
      if (user.role === "admin") {
        setLocation("/home");
      } else {
        setLocation("/sales");
      }
    }
  }, [user]);

  useEffect(() => {
    if (lockoutUntil === null) return;
    setNow(Date.now());
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= lockoutUntil) {
        setLockoutUntil(null);
        window.clearInterval(id);
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [lockoutUntil]);

  if (user) return null;

  const remainingSec =
    lockoutUntil !== null
      ? Math.max(0, Math.ceil((lockoutUntil - now) / 1000))
      : 0;
  const isLocked = remainingSec > 0;

  const onSubmit = (data: z.infer<typeof loginSchema>) => {
    if (isLocked) return;
    setInlineError(null);
    setAttemptsRemaining(null);
    loginMutation.mutate({ ...data, shop: shopName }, {
      onError: (error) => {
        if (error instanceof ApiError && error.status === 429) {
          const body = (error.body ?? {}) as { retryAfterSec?: unknown };
          const sec =
            typeof body.retryAfterSec === "number" && body.retryAfterSec > 0
              ? Math.ceil(body.retryAfterSec)
              : 60;
          setLockoutUntil(Date.now() + sec * 1000);
          setInlineError(null);
        } else {
          setInlineError(
            error instanceof ApiError && error.status === 401
              ? "Invalid username or password."
              : error.message,
          );
          if (error instanceof ApiError && error.status === 401) {
            const body = (error.body ?? {}) as { attemptsRemaining?: unknown };
            if (typeof body.attemptsRemaining === "number") {
              setAttemptsRemaining(Math.max(0, body.attemptsRemaining));
            }
          }
        }
      },
    });
  };

  return (
    <div className="auth-root">
      <div
        className="auth-bg"
        style={{ backgroundImage: `url(${bgImage})` }}
        aria-hidden="true"
      />
      <div className="auth-overlay" aria-hidden="true" />

      <div className="auth-card-wrapper">
        <div className="auth-card">
          <div className="auth-card-inner">
            <div className="flex justify-center mb-4">
              <img
                src={brrLogo}
                alt="BRR IT Solutions"
                className="w-20 h-20 object-contain rounded-full border-2 border-gray-100 shadow-md"
              />
            </div>

            {shopName && (
              <p className="text-center text-2xl font-bold text-blue-700 mb-1 tracking-wide">
                WELCOME TO {shopName}
              </p>
            )}

            <h1 className="text-center text-2xl font-bold text-red-700 mb-5 leading-tight">
              BRR Liquor Soft Login
            </h1>

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
                <FormField
                  control={form.control}
                  name="username"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-gray-700 font-medium">Username</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Enter username"
                          autoComplete="username"
                          className="border-gray-300 focus:border-red-400 focus:ring-red-400/20 rounded-md"
                          data-testid="input-username"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-gray-700 font-medium">Password</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder="Enter password"
                          autoComplete="current-password"
                          className="border-gray-300 focus:border-red-400 focus:ring-red-400/20 rounded-md"
                          data-testid="input-password"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {isLocked && (
                  <div
                    role="alert"
                    data-testid="login-lockout"
                    className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
                  >
                    <div className="font-semibold">Too many failed attempts</div>
                    <div>
                      For security, login is paused. Try again in{" "}
                      <span data-testid="login-lockout-remaining">
                        {formatRemaining(remainingSec)}
                      </span>
                      .
                    </div>
                  </div>
                )}
                {!isLocked && inlineError && (
                  <div
                    role="alert"
                    data-testid="login-error"
                    className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
                  >
                    <div>{inlineError}</div>
                    {attemptsRemaining !== null && attemptsRemaining <= 2 && (
                      <div
                        className="mt-1 font-semibold"
                        data-testid="login-attempts-warning"
                      >
                        {attemptsRemaining === 0
                          ? "No attempts remaining — this account is now temporarily locked."
                          : attemptsRemaining === 1
                            ? "1 attempt remaining before this account is temporarily locked."
                            : `${attemptsRemaining} attempts remaining before this account is temporarily locked.`}
                      </div>
                    )}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={loginMutation.isPending || isLocked}
                  data-testid="button-login"
                  className="w-full h-11 rounded-md text-white font-semibold text-base transition-opacity disabled:opacity-70 disabled:cursor-not-allowed mt-1"
                  style={{ backgroundColor: "#e03a2f" }}
                >
                  {isLocked
                    ? `Locked — wait ${formatRemaining(remainingSec)}`
                    : loginMutation.isPending
                      ? "Logging in..."
                      : "Login"}
                </button>
              </form>
            </Form>

            <button
              onClick={() => setLocation("/")}
              className="mt-4 w-full text-center text-sm text-gray-500 hover:text-gray-700 underline underline-offset-2"
            >
              ← Change shop
            </button>
          </div>
        </div>
      </div>

      <style>{`
        .auth-root {
          position: relative;
          min-height: 100vh;
          min-height: 100dvh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1rem;
          overflow: hidden;
        }
        .auth-bg {
          position: absolute;
          inset: 0;
          background-size: cover;
          background-position: center center;
          background-repeat: no-repeat;
          transform: scale(1.04);
          transform-origin: center;
          will-change: transform;
        }
        .auth-overlay {
          position: absolute;
          inset: 0;
          background: rgba(0, 0, 0, 0.30);
        }
        .auth-card-wrapper {
          position: relative;
          z-index: 10;
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .auth-card {
          width: 100%;
          max-width: 22rem;
          background: rgba(255, 255, 255, 0.97);
          border-radius: 1.25rem;
          box-shadow: 0 20px 60px rgba(0,0,0,0.35), 0 4px 16px rgba(0,0,0,0.15);
          overflow: hidden;
          -webkit-backdrop-filter: blur(8px);
          backdrop-filter: blur(8px);
        }
        .auth-card-inner {
          padding: 2rem 2rem 1.75rem;
        }
        @media (max-width: 400px) {
          .auth-card-inner { padding: 1.5rem 1.25rem 1.5rem; }
        }
        @media (min-width: 640px) {
          .auth-card { max-width: 24rem; }
        }
      `}</style>
    </div>
  );
}
