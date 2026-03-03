import { createServer } from "node:http";
import path from "node:path";
import cors from "cors";
import type { CorsOptions } from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env";
import { closePostgresMirror, initPostgresMirror } from "./db/postgres";
import { closeSqlServerConnection, getSqlServerHealthSnapshot, initSqlServerConnection, initSqlServerMirror } from "./db/sqlserver";
import { initDb } from "./db/sqlite";
import { authRequired } from "./middleware/auth";
import { requirePermission, requireRole } from "./middleware/authorization";
import { collectOpsMetrics } from "./middleware/ops-metrics";
import { collectOpsTracing } from "./middleware/ops-tracing";
import { detectClientPlatform } from "./middleware/platform";
import { rateLimit } from "./middleware/rate-limit";
import { attachRequestContext } from "./middleware/request-context";
import { adminRouter } from "./routes/admin.routes";
import { agentMarketplaceRouter } from "./routes/agent-marketplace.routes";
import { agentsRouter } from "./routes/agents.routes";
import { assetVaultRouter } from "./routes/asset-vault.routes";
import { authRouter } from "./routes/auth.routes";
import { cardsRouter } from "./routes/cards.routes";
import { chatRouter } from "./routes/chat.routes";
import { creativePointsRouter } from "./routes/creative-points.routes";
import { creatorsRouter } from "./routes/creators.routes";
import { devToolsRouter } from "./routes/dev-tools.routes";
import { duelsRouter } from "./routes/duels.routes";
import { marketplaceRouter } from "./routes/marketplace.routes";
import { meRouter } from "./routes/me.routes";
import { memoryRouter } from "./routes/memory.routes";
import { mcpRouter } from "./routes/mcp.routes";
import { projectsRouter } from "./routes/projects.routes";
import { rulesRouter } from "./routes/rules.routes";
import { skillsRouter } from "./routes/skills.routes";
import { toolsRouter } from "./routes/tools.routes";
import { trainingRouter } from "./routes/training.routes";
import { reymeshyRouter } from "./routes/reymeshy.routes";
import { setupSocket } from "./socket";
import { recordBootstrapFailure, startOpsMetricsPersistence, stopOpsMetricsPersistence } from "./services/ops-metrics";
import { startTrainingJobRunner } from "./services/training-jobs";
import { startVramSentinel, stopVramSentinel } from "./services/vram-sentinel";

async function bootstrap(): Promise<void> {
  await initDb();
  await initPostgresMirror();
  await initSqlServerConnection();
  await initSqlServerMirror();
  startOpsMetricsPersistence();
  startVramSentinel();

  if (env.TRAINING_QUEUE_BACKEND === "redis" && !env.REDIS_URL) {
    throw new Error("REDIS_URL is required when TRAINING_QUEUE_BACKEND=redis");
  }

  if (env.TRAINING_RUNNER_MODE === "inline") {
    await startTrainingJobRunner();
  } else {
    console.log(`[training-runner] inline disabled (mode=${env.TRAINING_RUNNER_MODE})`);
  }

  const app = express();
  if (env.TRUST_PROXY) {
    app.set("trust proxy", 1);
  }

  const corsOptions: CorsOptions = {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (env.CORS_ORIGINS.includes("*") || env.CORS_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Not allowed by CORS"));
    },
    credentials: true
  };

  app.use(cors(corsOptions));
  app.use(helmet());
  app.use(express.json({ limit: "1mb" }));
  app.use(attachRequestContext);
  morgan.token("request-id", (req) => (req as express.Request).requestId ?? "-");
  app.use(morgan(":method :url :status :response-time ms reqId=:request-id"));
  app.use(detectClientPlatform);
  app.use(collectOpsTracing);
  app.use("/api", collectOpsMetrics);
  app.use(
    "/api",
    rateLimit({
      windowMs: env.API_RATE_LIMIT_WINDOW_MS,
      max: env.API_RATE_LIMIT_MAX,
      maxBuckets: env.API_RATE_LIMIT_MAX_BUCKETS
    })
  );

  const publicDir = path.resolve(__dirname, "..", "public");
  app.get("/", (_req, res) => {
    res.redirect("/app");
  });
  app.get("/app", (_req, res) => {
    res.sendFile(path.join(publicDir, "app", "index.html"));
  });
  app.get("/console", (_req, res) => {
    res.sendFile(path.join(publicDir, "console", "index.html"));
  });
  app.get("/reycad", (_req, res) => {
    res.sendFile(path.join(publicDir, "reycad", "index.html"));
  });
  app.get("/favicon.ico", (_req, res) => {
    res.redirect("/shared/favicon.svg");
  });
  app.use(express.static(publicDir));

  app.get("/health", (_req, res) => {
    const sqlServerSnapshot = getSqlServerHealthSnapshot();
    const postgresMirrorConfigured = Boolean(env.POSTGRES_URL && env.POSTGRES_URL.trim().length > 0);
    const postgresMirrorRequired = env.POSTGRES_DUAL_WRITE;
    const postgresMirrorReady = !postgresMirrorRequired || postgresMirrorConfigured;
    const sqlServerRequired = env.DB_ENGINE === "sqlserver" || (env.SQL_SERVER_ENABLED && env.SQL_SERVER_DUAL_WRITE);
    const sqlServerReady = !sqlServerRequired || (sqlServerSnapshot.configured && sqlServerSnapshot.connected);
    const ready = postgresMirrorReady && sqlServerReady;
    res.setHeader("Cache-Control", "no-store");
    res.status(ready ? 200 : 503).json({
      ok: ready,
      app: "rey30-card-mvp-backend",
      timestamp: new Date().toISOString(),
      readiness: {
        ready,
        checks: {
          sqlite: true,
          postgresMirror: postgresMirrorReady,
          sqlServer: sqlServerReady
        },
        required: {
          postgresMirror: postgresMirrorRequired,
          sqlServer: sqlServerRequired
        }
      },
      db: {
        sqlite: {
          engine: "sqlite",
          path: env.DB_PATH,
          connected: true
        },
        postgresMirror: {
          enabledByEnv: env.POSTGRES_DUAL_WRITE,
          configured: postgresMirrorConfigured,
          ready: postgresMirrorReady
        },
        sqlServer: {
          ...sqlServerSnapshot,
          ready: sqlServerReady,
          dualWriteEnabledByEnv: env.SQL_SERVER_DUAL_WRITE
        }
      }
    });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/cards", cardsRouter);
  app.use("/api/creative-points", creativePointsRouter);
  app.use("/api/duels", duelsRouter);
  app.use("/api/marketplace", marketplaceRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/me", meRouter);
  app.use("/api/projects", projectsRouter);
  app.use("/api/creators", creatorsRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/agents", agentsRouter);
  app.use("/api/rules", rulesRouter);
  app.use("/api/skills", skillsRouter);
  app.use("/api/tools", toolsRouter);
  app.use("/api/memory", memoryRouter);
  app.use("/api/training", trainingRouter);
  app.use("/api/reymeshy", reymeshyRouter);
  app.use("/api/mcp", mcpRouter);
  app.use("/api/vault", assetVaultRouter);
  app.use("/api/dev-tools", devToolsRouter);
  app.use("/api/agent-marketplace", agentMarketplaceRouter);
  app.use(
    "/api/publish",
    authRequired,
    requireRole("approvedCreator"),
    requirePermission("publish.agent_template"),
    agentMarketplaceRouter
  );

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const handled = err as { status?: number; statusCode?: number; type?: string };
    const statusCode =
      typeof handled.status === "number" ? handled.status : typeof handled.statusCode === "number" ? handled.statusCode : 500;

    if (handled.type === "entity.too.large" || statusCode === 413) {
      res.status(413).json({ error: "Request payload too large" });
      return;
    }

    if (statusCode >= 400 && statusCode < 500) {
      res.status(statusCode).json({ error: "Bad request" });
      return;
    }

    console.error("Unhandled error", err);
    res.status(500).json({ error: "Internal server error" });
  });

  const server = createServer(app);
  setupSocket(server);

  server.listen(env.PORT, () => {
    console.log(`Backend running at http://localhost:${env.PORT}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[bootstrap] received ${signal}; shutting down`);
    void Promise.all([stopOpsMetricsPersistence(), stopVramSentinel(), closeSqlServerConnection(), closePostgresMirror()]).finally(() => {
      server.close(() => {
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 5000).unref();
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

bootstrap().catch(async (err) => {
  recordBootstrapFailure(err);
  console.error("Failed to bootstrap application", err);
  await Promise.allSettled([stopOpsMetricsPersistence(), stopVramSentinel(), closeSqlServerConnection(), closePostgresMirror()]);
  process.exit(1);
});
