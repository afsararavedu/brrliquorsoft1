
import "dotenv/config";
import { AsyncLocalStorage } from "async_hooks";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as dbSchema from "@workspace/db";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const { Pool, Client } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// DB_SCHEMA selects the PostgreSQL schema (search_path) for this tenant.
// e.g. DB_SCHEMA=balaji_schema  →  all tables resolved inside balaji_schema.
// Defaults to "public" when not set (standard single-tenant behaviour).
export const DB_SCHEMA = process.env.DB_SCHEMA || "public";

// DIRECT_DATABASE_URL (optional) points to the PostgreSQL server directly
// (port 5432) and is used only for DDL operations (CREATE SCHEMA) that
// PgBouncer in transaction mode does not support.
const BOOTSTRAP_URL =
  process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL!;

// Shop name → PostgreSQL schema name mapping.
// Used by the login endpoint to route each shop to its own isolated schema.
export const SHOP_SCHEMA_MAP: Record<string, string> = {
  Balaji:   "balaji_schema",
  Jyothi:   "jyothi_schema",
  Padma:    "padma_schema",
  Mallanna: "mallanna_schema",
};

// ── AsyncLocalStorage for per-request schema selection ────────────────────────
const _schemaALS = new AsyncLocalStorage<string>();

/** Returns the schema active for the current request, or the default DB_SCHEMA. */
export function getActiveSchema(): string {
  return _schemaALS.getStore() ?? DB_SCHEMA;
}

/**
 * Run `fn` with the given schema set as the active schema for this async
 * context. All storage/db calls inside fn (and anything they await) will
 * transparently use the correct per-shop pool.
 */
export function runInSchema<T>(schema: string, fn: () => T): T {
  return _schemaALS.run(schema, fn);
}
// ──────────────────────────────────────────────────────────────────────────────

// Embed search_path in the PostgreSQL connection string so every connection
// from the pool automatically targets the configured schema.
function buildConnectionString(base: string, dbSchema: string): string {
  const url = new URL(base);
  const existing = url.searchParams.get("options") ?? "";
  const schemaOption = `-c search_path=${dbSchema}`;
  url.searchParams.set(
    "options",
    existing ? `${existing} ${schemaOption}` : schemaOption,
  );
  return url.toString();
}

// ── Default (main) pool & db ───────────────────────────────────────────────
// These are bootstrapped at startup for DB_SCHEMA (or "public").
// They are also the fallback when a per-shop schema entry hasn't been
// initialised yet (should not happen in normal flow).

const _mainPool = new Pool({
  connectionString: buildConnectionString(process.env.DATABASE_URL!, DB_SCHEMA),
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,
  ssl: { rejectUnauthorized: false },
});

_mainPool.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("Unexpected database pool error:", err.message);
});

const _mainDb = drizzle(_mainPool, { schema: dbSchema });

// ── Schema bootstrap for the default schema (top-level await) ─────────────
if (DB_SCHEMA !== "public") {
  const bootstrapClient = new Client({
    connectionString: BOOTSTRAP_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await bootstrapClient.connect();
    await bootstrapClient.query(`CREATE SCHEMA IF NOT EXISTS "${DB_SCHEMA}"`);
    // eslint-disable-next-line no-console
    console.info(`[db] Schema "${DB_SCHEMA}" is ready.`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[db] Could not create schema "${DB_SCHEMA}": ${msg}`);
  } finally {
    await bootstrapClient.end().catch(() => {});
  }
}

// ── Auto-migration for the default schema (top-level await) ───────────────
{
  const here = dirname(fileURLToPath(import.meta.url));
  const prodMigrationsDir = join(here, "../migrations");
  const devMigrationsDir  = join(here, "../../../lib/db/migrations");

  const migrationsDir = existsSync(prodMigrationsDir) ? prodMigrationsDir
                      : existsSync(devMigrationsDir)  ? devMigrationsDir
                      : null;

  if (migrationsDir) {
    try {
      // migrationsSchema keeps the tracking table in the target schema
      // instead of creating a separate 'drizzle' schema.
      await migrate(_mainDb, { migrationsFolder: migrationsDir, migrationsSchema: DB_SCHEMA });
      // eslint-disable-next-line no-console
      console.info(`[db] Migrations applied from ${migrationsDir}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[db] Migration failed: ${msg}`);
    }
  } else {
    // eslint-disable-next-line no-console
    console.warn("[db] No migrations folder found — skipping auto-migrate.");
  }
}

// Pre-populate the schema cache with the default pool+db so the proxy
// can serve it immediately without going through the lazy init path.
type DbEntry = { pool: pg.Pool; db: ReturnType<typeof drizzle<typeof dbSchema>> };
const _schemaCache = new Map<string, DbEntry>();
_schemaCache.set(DB_SCHEMA, { pool: _mainPool, db: _mainDb });

// ── Per-schema lazy initialisation ────────────────────────────────────────
const _initLocks = new Map<string, Promise<void>>();

/**
 * Ensure the given PostgreSQL schema exists and has all migrations applied.
 * Creates a dedicated connection pool for it and caches the drizzle instance.
 * Safe to call multiple times — subsequent calls for the same schema are no-ops.
 */
export async function initSchemaIfNeeded(schemaName: string): Promise<void> {
  if (_schemaCache.has(schemaName)) return;

  // Deduplicate concurrent init calls for the same schema
  const existing = _initLocks.get(schemaName);
  if (existing) return existing;

  const promise = (async () => {
    // 1. Create the schema if it doesn't exist
    if (schemaName !== "public") {
      const bc = new Client({
        connectionString: BOOTSTRAP_URL,
        ssl: { rejectUnauthorized: false },
      });
      try {
        await bc.connect();
        await bc.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
        // eslint-disable-next-line no-console
        console.info(`[db] Schema "${schemaName}" created/verified.`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(`[db] Could not create schema "${schemaName}": ${msg}`);
      } finally {
        await bc.end().catch(() => {});
      }
    }

    // 2. Create a dedicated pool for this schema
    const schemaPool = new Pool({
      connectionString: buildConnectionString(process.env.DATABASE_URL!, schemaName),
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 30000,
      ssl: { rejectUnauthorized: false },
    });
    schemaPool.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error(`[db][${schemaName}] Pool error:`, err.message);
    });

    const schemaDb = drizzle(schemaPool, { schema: dbSchema });

    // 3. Run migrations for this schema
    {
      const here = dirname(fileURLToPath(import.meta.url));
      const prodMigrationsDir = join(here, "../migrations");
      const devMigrationsDir  = join(here, "../../../lib/db/migrations");
      const migrationsDir = existsSync(prodMigrationsDir) ? prodMigrationsDir
                          : existsSync(devMigrationsDir)  ? devMigrationsDir
                          : null;
      if (migrationsDir) {
        try {
          // migrationsSchema keeps the tracking table inside the target schema
          // so each shop schema is self-contained and doesn't pollute 'drizzle'.
          await migrate(schemaDb, { migrationsFolder: migrationsDir, migrationsSchema: schemaName });
          // eslint-disable-next-line no-console
          console.info(`[db] Migrations applied for schema "${schemaName}".`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.error(`[db] Migration failed for schema "${schemaName}": ${msg}`);
        }
      }
    }

    _schemaCache.set(schemaName, { pool: schemaPool, db: schemaDb });
    _initLocks.delete(schemaName);
  })();

  _initLocks.set(schemaName, promise);
  return promise;
}

// ── Eager startup bootstrap for all shop schemas ──────────────────────────
// On every startup / deploy, create all four shop schemas and apply migrations
// so tables exist before any user logs in. Runs in parallel for speed.
{
  const shopSchemas = Object.values(SHOP_SCHEMA_MAP);
  // eslint-disable-next-line no-console
  console.info(`[db] Bootstrapping shop schemas: ${shopSchemas.join(", ")} …`);
  await Promise.all(shopSchemas.map((s) => initSchemaIfNeeded(s)))
    .then(() => {
      // eslint-disable-next-line no-console
      console.info("[db] All shop schemas are ready.");
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[db] Shop schema bootstrap error: ${msg}`);
    });
}

// ── Remove legacy 'drizzle' schema ────────────────────────────────────────
// Older builds stored Drizzle migration metadata in a top-level 'drizzle'
// schema. Now each schema tracks its own migrations (migrationsSchema option),
// so the global 'drizzle' schema is no longer needed. Drop it if it exists.
{
  const bc = new Client({
    connectionString: BOOTSTRAP_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await bc.connect();
    await bc.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    // eslint-disable-next-line no-console
    console.info('[db] Legacy "drizzle" schema removed (or was already absent).');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[db] Could not remove "drizzle" schema: ${msg}`);
  } finally {
    await bc.end().catch(() => {});
  }
}

// ── Helper ─────────────────────────────────────────────────────────────────
function _getEntry(schema: string): DbEntry {
  const entry = _schemaCache.get(schema);
  if (!entry) {
    // This should never happen in normal operation — all shop schemas are
    // eagerly bootstrapped at startup. Reaching here means a schema init
    // failed silently. Log a clear warning so it shows up in journalctl.
    // eslint-disable-next-line no-console
    console.warn(
      `[db] WARNING: schema "${schema}" not found in cache — falling back to ` +
      `main pool (${DB_SCHEMA}). Check startup logs for schema init errors. ` +
      `Data returned may belong to the wrong shop.`
    );
    return { pool: _mainPool, db: _mainDb };
  }
  return entry;
}

// ── Exports ────────────────────────────────────────────────────────────────

/**
 * The raw main pool (for the DB_SCHEMA / default schema).
 * Used by the session store so sessions are always written to a single,
 * stable schema regardless of which shop the user is logged into.
 */
export const mainPool: pg.Pool = _mainPool;

/**
 * Schema-aware pool proxy. Routes to the pool of whichever schema is active
 * in the current AsyncLocalStorage context (set by the schema middleware).
 * Falls back to the main pool when no schema is set.
 */
export const pool = new Proxy({} as pg.Pool, {
  get(_, prop) {
    const entry = _getEntry(getActiveSchema());
    const val = (entry.pool as unknown as Record<string | symbol, unknown>)[prop];
    return typeof val === "function" ? (val as Function).bind(entry.pool) : val;
  },
});

/**
 * Schema-aware drizzle proxy. Routes queries to the drizzle instance of
 * whichever schema is active in the current AsyncLocalStorage context.
 * Falls back to the main db when no schema is set.
 */
export const db = new Proxy({} as typeof _mainDb, {
  get(_, prop) {
    const entry = _getEntry(getActiveSchema());
    const val = (entry.db as unknown as Record<string | symbol, unknown>)[prop];
    return typeof val === "function" ? (val as Function).bind(entry.db) : val;
  },
});
