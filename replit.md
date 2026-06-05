# BRR Liquor Soft — Workspace

## Overview

pnpm workspace monorepo using TypeScript. Contains the BRR Liquor Soft web app (sales & inventory management for a liquor business), ported from a single-app structure into a multi-artifact workspace.

## Artifacts

- **`artifacts/brr-web/`** — React + Vite frontend, preview path `/` (port 18172 in dev)
- **`artifacts/api-server/`** — Express 5 backend API, preview path `/api`
- **`artifacts/mockup-sandbox/`** — Design/mockup canvas (pre-existing)

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React 18, Wouter routing, TanStack Query, Tailwind CSS v3, shadcn/ui components
- **API framework**: Express 5
- **Auth**: Passport.js (local strategy) + express-session + connect-pg-simple
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod v3
- **File import**: multer + xlsx (Excel parsing), pdf-parse (PDF parsing)
- **Build**: esbuild (api-server), Vite (frontend)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/db run push-force` — force push DB schema (drops conflicting tables)

## Project Structure

```
artifacts/
  api-server/        # Express backend
    src/
      auth.ts        # Passport.js auth setup
      db.ts          # DB connection pool
      storage.ts     # Data access layer
      routes/
        routes.ts    # All API routes (registerRoutes)
        health.ts    # Health check route
      shared/
        routes.ts    # API route contract (paths + zod schemas)
  brr-web/           # React frontend
    src/
      App.tsx        # Main app with routing
      pages/         # Page components
      components/    # Shared UI components
      hooks/         # Custom hooks (auth, sales, orders)
      lib/           # queryClient, utils
      shared/        # Local type definitions + API contract
lib/
  db/                # Shared DB schema (Drizzle tables + types)
  api-spec/          # OpenAPI spec
  api-zod/           # Generated Zod schemas
  api-client-react/  # Generated React Query hooks
```

## Notes

- The replit.md mentions `zod/v4` but the workspace actually uses `zod` v3 (`^3.25.76`)
- The frontend's `@shared/*` alias resolves to `artifacts/brr-web/src/shared/` (local type copies, no backend imports)
- Session store uses `connect-pg-simple` (PostgreSQL-backed sessions)
- **Shop selection landing page**: The app starts at `/` with a full-screen shop selector (Balaji, Jyothi, Padma, Mallanna). Selecting a shop navigates to `/login?shop=<name>` which shows "Welcome to <Shop Name>" above the login form. After login, admins go to `/home`, employees to `/sales`. A "← Change shop" link returns to the landing page.
- **Multi-tenant DB schema routing**: Each shop maps to its own PostgreSQL schema (`balaji_schema`, `jyothi_schema`, `padma_schema`, `mallanna_schema`). At login the chosen schema is bootstrapped (CREATE SCHEMA IF NOT EXISTS + migrations) if not yet initialised, then stored in `req.session.shopSchema`. A per-request middleware (`runInSchema`) sets an AsyncLocalStorage context, and the exported `db` and `pool` in `db.ts` are Proxies that transparently route all queries to the correct per-shop pool. The session store always uses `mainPool` (the default `DB_SCHEMA` pool) so sessions are stable across shop switches.
- Password expiry: every user row carries `password_changed_at`. The api
  exposes a server-computed `passwordExpired` boolean on `/api/login` and
  `/api/user` responses (true when `password_changed_at` is older than 90
  days). The frontend forces a redirect to `/reset-password` only when
  `passwordExpired === true`. Users can also reset their password on
  demand via the "Reset Password" button in the sidebar.
- **Voice input on Sales page**: A "Voice" button in the toolbar uses the browser's Web Speech API (`SpeechRecognition`/`webkitSpeechRecognition`) for hands-free data entry. Supported commands: dictate brand number + size + closing cases/bottles/breakage to update a row; "save sales" to save; "save and submit" to save + submit; date commands like "select today" or "first December 2025" to change the date picker. The feature requires a browser that supports the Web Speech API (Chrome, Edge, Safari).
- Initial admin bootstrap: on first startup against an empty `users` table the api-server creates a single `admin` account. The password comes from `ADMIN_BOOTSTRAP_PASSWORD` if that env var is set (must be ≥ 8 characters), otherwise a random one is generated and printed once to the server log. The account is created with `mustResetPassword: true`, so the operator is forced to set a real password on first login. No other accounts (including any "employee" account) are seeded — additional users must be created from inside the app by an admin.

## Deploying to AWS EC2

A self-hosted alternative to Replit publishing. See `docs/deploy/aws-ec2.md` for
the full runbook (EC2 + RDS Postgres + nginx + systemd). Supporting files:

- `scripts/deploy/build-release.sh` — produces a `release/` folder with the
  api-server bundle (`release/api/`) and the static web build (`release/web/`).
- `deploy/aws-ec2/nginx.conf.example` — reverse proxy with SPA fallback and
  `/api/*` → loopback forwarding.
- `deploy/aws-ec2/brr-api.service.example` — systemd unit for the api-server.
- `deploy/aws-ec2/brr-api.env.example` — env-var template (`DATABASE_URL`,
  `SESSION_SECRET`, optional `ADMIN_BOOTSTRAP_PASSWORD`).


## Required production secrets

- **`SESSION_SECRET`** — Long random string used to sign session cookies. **Required when `NODE_ENV=production`**: the api-server refuses to start without it (see `artifacts/api-server/src/index.ts`). In development a clear warning is logged and an insecure fallback is used. Generate with `openssl rand -hex 32`.
- **`ADMIN_BOOTSTRAP_PASSWORD`** *(optional)* — One-time password used when bootstrapping the very first admin account. Only consulted when no admin user exists yet. If unset, a random password is generated and printed once to the server log. Either way the account is created with `mustResetPassword: true` and must change its password on first login.
