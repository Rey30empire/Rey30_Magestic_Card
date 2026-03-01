import { Router } from "express";
import { get } from "../db/sqlite";
import { authRequired } from "../middleware/auth";

type UserProgressRow = {
  creative_points: number;
  elo: number;
};

export const creativePointsRouter = Router();

creativePointsRouter.get("/me", authRequired, async (req, res) => {
  const row = await get<UserProgressRow>("SELECT creative_points, elo FROM users WHERE id = ?", [req.user!.id]);
  if (!row) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({
    creativePoints: row.creative_points,
    elo: row.elo
  });
});
