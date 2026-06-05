import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Express, RequestHandler } from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import { storage } from "./storage";
import { User as SelectUser } from "@workspace/db";
import { logger } from "./lib/logger";
import {
  checkLocked,
  loginKeysFor,
  recordFailure,
  recordSuccess,
  remainingAttempts,
} from "./loginRateLimiter";
import {
  DB_SCHEMA,
  SHOP_SCHEMA_MAP,
  initSchemaIfNeeded,
  runInSchema,
  getActiveSchema,
} from "./db";

// Extend the express-session SessionData so TypeScript knows about our
// extra fields (shopSchema, shopName) that we attach to the session at login.
declare module "express-session" {
  interface SessionData {
    shopSchema?: string;
    shopName?: string;
  }
}

const DEV_SESSION_SECRET_FALLBACK = "salespro-dev-only-not-for-production";

declare global {
  namespace Express {
    interface User extends SelectUser {}
  }
}

/**
 * Build the JSON-safe user payload sent on /api/login, /api/user and
 * /api/register. Strips credential material (password hash)
 * that the browser never needs to see.
 */
function safeUserResponse(user: SelectUser, shopName?: string | null) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { password, ...rest } = user;
  return { ...rest, shopName: shopName ?? null };
}

/**
 * Middleware that requires a valid authenticated session.
 */
export const requireAuth: RequestHandler = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  req.log?.warn({
    hasCookie:   !!(req.headers.cookie),
    sessionID:   req.sessionID ?? "(none)",
    hasPassport: !!((req.session as unknown as Record<string, unknown>)?.passport),
  }, "requireAuth: unauthenticated — check [session-store] ERROR lines if hasCookie=false");
  return res.status(401).json({ message: "Unauthorized" });
};

/**
 * Middleware that requires the authenticated user to have role === "admin".
 */
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  if ((req.user as SelectUser).role !== "admin") {
    return res.status(403).json({ message: "Admin only" });
  }
  return next();
};

export function setupAuth(app: Express) {
  const isProduction = app.get("env") === "production";

  const envSecret = process.env.SESSION_SECRET;
  if (isProduction && !envSecret) {
    throw new Error(
      "SESSION_SECRET environment variable is required in production. " +
        "Refusing to start with a hardcoded fallback secret because that " +
        "would let anyone forge valid login cookies for any user.",
    );
  }
  if (!envSecret) {
    logger.warn(
      "SESSION_SECRET is not set; using an insecure development fallback. " +
        "Set SESSION_SECRET to a long random value before deploying.",
    );
  }
  const secret = envSecret || DEV_SESSION_SECRET_FALLBACK;

  if (isProduction) {
    app.set("trust proxy", 1);
  }

  const rawCookieSecure = process.env.COOKIE_SECURE;
  const cookieSecure: boolean | "auto" =
    rawCookieSecure === "true"  ? true  :
    rawCookieSecure === "false" ? false :
    isProduction                ? "auto": false;

  const sessionSettings: session.SessionOptions = {
    secret,
    resave: false,
    saveUninitialized: false,
    store: storage.sessionStore,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: cookieSecure,
      sameSite: "lax",
    },
  };

  logger.info(
    { isProduction, cookieSecure, COOKIE_SECURE: rawCookieSecure ?? "(unset)" },
    "Session cookie settings — if EC2 gets 401 after login set COOKIE_SECURE=false in /etc/brr/brr-api.env",
  );

  app.use(session(sessionSettings));
  app.use(passport.initialize());
  app.use(passport.session());

  // ── Per-request schema context middleware ──────────────────────────────
  // Runs AFTER the session middleware so req.session is already populated.
  // Sets the AsyncLocalStorage schema context so all downstream DB queries
  // transparently use the shop's own PostgreSQL schema.
  app.use((req, _res, next) => {
    const schema = req.session?.shopSchema ?? DB_SCHEMA;
    runInSchema(schema, () => next());
  });
  // ───────────────────────────────────────────────────────────────────────

  passport.use(
    new LocalStrategy(async (username, password, done) => {
      try {
        const user = await storage.getUserByUsername(username);
        if (!user) {
          return done(null, false, { message: "Invalid username or password" });
        }
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
          return done(null, false, { message: "Invalid username or password" });
        }
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    })
  );

  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  // 3-arity form: Passport 0.6+ passes req as the first arg when the
  // deserializer declares 3 parameters. We cast through `any` because the
  // installed @types/passport typedefs don't expose this overload, but the
  // runtime behaviour is correct. Reading shopSchema from the session lets us
  // route the user lookup to the correct per-shop schema.
  (passport.deserializeUser as any)(async (req: any, id: number, done: (err: unknown, user?: SelectUser | null) => void) => {
    try {
      const schema: string = req?.session?.shopSchema ?? DB_SCHEMA;
      const user = await runInSchema(schema, () => storage.getUser(id));
      done(null, user ?? null);
    } catch (err) {
      done(err);
    }
  });

  app.post("/api/register", async (req, res, next) => {
    try {
      const existingUser = await storage.getUserByUsername(req.body.username);
      if (existingUser) {
        return res.status(400).send("Username already exists");
      }

      const hashedPassword = await bcrypt.hash(req.body.password, 10);
      const user = await storage.createUser({
        ...req.body,
        password: hashedPassword,
        passwordChangedAt: new Date(),
      });

      return req.login(user, (err) => {
        if (err) return next(err);
        return res.status(201).json(safeUserResponse(user));
      });
    } catch (err) {
      return next(err);
    }
  });

  app.post("/api/login", async (req, res, next) => {
    const username = req.body?.username;
    const shopParam = typeof req.body?.shop === "string" ? req.body.shop : "";
    const keys = loginKeysFor(req, username);

    const lockState = checkLocked(keys);
    if (lockState.locked) {
      res.setHeader("Retry-After", String(lockState.retryAfterSec));
      logger.warn(
        {
          username: typeof username === "string" ? username : undefined,
          ip: req.ip,
          retryAfterSec: lockState.retryAfterSec,
        },
        "Login rejected: too many failed attempts",
      );
      return res.status(429).json({
        message: "Too many failed login attempts. Please try again later.",
        retryAfterSec: lockState.retryAfterSec,
      });
    }

    // Resolve the shop → schema. Fall back to the default DB_SCHEMA so
    // deployments without a shop selection still work (e.g. single-tenant).
    const shopSchema = SHOP_SCHEMA_MAP[shopParam] ?? DB_SCHEMA;
    const shopName   = shopParam || null;

    // Ensure the target schema exists and has all migrations applied.
    // This is a no-op if the schema was already initialised.
    try {
      await initSchemaIfNeeded(shopSchema);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ shopSchema, err: msg }, "Failed to initialise shop schema");
      return res.status(500).json({ message: "Failed to initialise shop schema" });
    }

    // Authenticate inside the target schema context so getUserByUsername
    // and subsequent queries use the correct pool.
    return new Promise<void>((resolve) => {
      runInSchema(shopSchema, () => {
        passport.authenticate(
          "local",
          (err: Error | null, user: SelectUser | false) => {
            if (err) { next(err); return resolve(); }
            if (!user) {
              recordFailure(keys);
              const remaining = remainingAttempts(keys);
              res.status(401).json({
                message: "Invalid username or password",
                attemptsRemaining: remaining,
              });
              return resolve();
            }
            req.login(user, (loginErr) => {
              if (loginErr) { next(loginErr); return resolve(); }
              recordSuccess(keys);
              // Persist the chosen shop in the session so every subsequent
              // request is routed to the same schema automatically.
              req.session.shopSchema = shopSchema;
              req.session.shopName   = shopName ?? undefined;
              req.session.save((saveErr) => {
                if (saveErr) logger.warn({ saveErr }, "Session save error after login");
                res.status(200).json(safeUserResponse(user, shopName));
                resolve();
              });
            });
          },
        )(req, res, next);
      });
    });
  });

  app.post("/api/logout", (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      req.session.destroy((destroyErr) => {
        if (destroyErr) return next(destroyErr);
        res.clearCookie("connect.sid", { path: "/" });
        res.sendStatus(200);
      });
    });
  });

  app.get("/api/user", (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    return res.json(safeUserResponse(req.user as SelectUser, req.session.shopName));
  });

  app.post("/api/reset-password", async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    const { password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    await storage.updateUser(req.user!.id, {
      password: hashedPassword,
      passwordChangedAt: new Date(),
    });
    return res.sendStatus(200);
  });
}
