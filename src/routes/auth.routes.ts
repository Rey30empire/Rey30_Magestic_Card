import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { auditLog, get, run } from "../db/sqlite";
import { signToken } from "../middleware/auth";
import { assignRoleToUser } from "../services/rbac";

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  creative_points: number;
  elo: number;
};

const registerSchema = z.object({
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, "Only alphanumeric and _"),
  password: z.string().min(8).max(120)
});

const loginSchema = z.object({
  username: z.string().min(3).max(30),
  password: z.string().min(8).max(120)
});

export const authRouter = Router();

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const existing = await get<UserRow>("SELECT * FROM users WHERE username = ?", [parsed.data.username]);
  if (existing) {
    res.status(409).json({ error: "Username already exists" });
    return;
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const passwordHash = await bcrypt.hash(parsed.data.password, 10);

  await run(
    `
      INSERT INTO users (id, username, password_hash, role, creative_points, elo, created_at)
      VALUES (?, ?, ?, 'user', ?, 1000, ?)
    `,
    [id, parsed.data.username, passwordHash, env.CREATIVE_POINTS_START, now]
  );
  await assignRoleToUser(id, "user", null);

  await auditLog(id, "auth.register", { username: parsed.data.username });

  const token = signToken({
    id,
    username: parsed.data.username,
    role: "user"
  });

  res.status(201).json({
    token,
    user: {
      id,
      username: parsed.data.username,
      role: "user",
      creativePoints: env.CREATIVE_POINTS_START,
      elo: 1000
    }
  });
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const user = await get<UserRow>("SELECT * FROM users WHERE username = ?", [parsed.data.username]);
  if (!user) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const ok = await bcrypt.compare(parsed.data.password, user.password_hash);
  if (!ok) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  await auditLog(user.id, "auth.login", { username: user.username });

  const token = signToken({
    id: user.id,
    username: user.username,
    role: user.role
  });

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      creativePoints: user.creative_points,
      elo: user.elo
    }
  });
});
