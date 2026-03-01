import { Router } from "express";
import { z } from "zod";
import { all } from "../db/sqlite";
import { authRequired } from "../middleware/auth";

type ChatMessageRow = {
  id: string;
  channel: string;
  sender_user_id: string;
  sender_name: string;
  message: string;
  created_at: string;
};

const paramsSchema = z.object({
  channel: z.string().min(1).max(30)
});

export const chatRouter = Router();

chatRouter.get("/:channel", authRequired, async (req, res) => {
  const parsed = paramsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid channel" });
    return;
  }

  const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

  const rows = await all<ChatMessageRow>(
    `
      SELECT
        m.id,
        m.channel,
        m.sender_user_id,
        u.username AS sender_name,
        m.message,
        m.created_at
      FROM chat_messages m
      INNER JOIN users u ON u.id = m.sender_user_id
      WHERE m.channel = ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `,
    [parsed.data.channel, limit]
  );

  res.json({
    channel: parsed.data.channel,
    items: rows.reverse().map((row) => ({
      id: row.id,
      channel: row.channel,
      senderUserId: row.sender_user_id,
      senderName: row.sender_name,
      message: row.message,
      createdAt: row.created_at
    }))
  });
});
