import { createServer } from "node:http";
import path from "node:path";
import cors from "cors";
import type { CorsOptions } from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env";
import { initPostgresMirror } from "./db/postgres";
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
import { projectsRouter } from "./routes/projects.routes";
import { rulesRouter } from "./routes/rules.routes";
import { skillsRouter } from "./routes/skills.routes";
import { toolsRouter } from "./routes/tools.routes";
import { trainingRouter } from "./routes/training.routes";
import { setupSocket } from "./socket";
import { recordBootstrapFailure, startOpsMetricsPersistence, stopOpsMetricsPersistence } from "./services/ops-metrics";
import { startTrainingJobRunner } from "./services/training-jobs";

async function bootstrap(): Promise<void> {
  await initDb();
  await initPostgresMirror();
  startOpsMetricsPersistence();

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
    res.json({
      ok: true,
      app: "rey30-card-mvp-backend",
      timestamp: new Date().toISOString()
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
    void stopOpsMetricsPersistence().finally(() => {
      server.close(() => {
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 5000).unref();
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

bootstrap().catch((err) => {
  recordBootstrapFailure(err);
  console.error("Failed to bootstrap application", err);
  process.exit(1);
});
