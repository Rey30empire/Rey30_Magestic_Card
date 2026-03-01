import { randomUUID } from "node:crypto";
import { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { Server, Socket } from "socket.io";
import { env } from "./config/env";
import { run } from "./db/sqlite";
import { MatchmakingService, MatchMode, Platform } from "./services/matchmaking";
import { moderateMessage } from "./services/moderation";

type JwtPayload = {
  sub: string;
  username: string;
  role: "user" | "admin";
};

type ChatPayload = {
  channel: string;
  message: string;
};

type MatchmakingPayload = {
  mode: MatchMode;
  platform: Platform;
  crossplay?: boolean;
  rating: number;
};

const matchmaking = new MatchmakingService();
const CHANNEL_PATTERN = /^[a-zA-Z0-9:_-]{1,30}$/;
const SOCKET_EVENT_WINDOW_MS = 10_000;
const SOCKET_EVENT_MAX = 40;

type SocketRateBucket = {
  count: number;
  resetAt: number;
};

function readSocketToken(socket: Socket): string {
  const authToken = typeof socket.handshake.auth?.token === "string" ? socket.handshake.auth.token : "";
  if (authToken.trim().length > 0) {
    return authToken.trim();
  }

  const authorization = socket.handshake.headers?.authorization;
  const header = typeof authorization === "string" ? authorization : Array.isArray(authorization) ? authorization[0] ?? "" : "";
  if (header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (token.length > 0) {
      return token;
    }
  }

  return "";
}

function allowSocketEvent(socket: Socket, eventName: string): boolean {
  const key = `rl:${eventName}`;
  const now = Date.now();
  const current = socket.data[key] as SocketRateBucket | undefined;
  if (!current || current.resetAt <= now) {
    socket.data[key] = {
      count: 1,
      resetAt: now + SOCKET_EVENT_WINDOW_MS
    } satisfies SocketRateBucket;
    return true;
  }

  if (current.count >= SOCKET_EVENT_MAX) {
    return false;
  }

  current.count += 1;
  socket.data[key] = current;
  return true;
}

export function setupSocket(server: HttpServer): Server {
  const allowedOrigins = env.SOCKET_CORS_ORIGINS.includes("*") ? "*" : env.SOCKET_CORS_ORIGINS;
  const io = new Server(server, {
    cors: { origin: allowedOrigins }
  });

  io.on("connection", (socket) => {
    const token = readSocketToken(socket);

    if (!token) {
      socket.emit("error:auth", { error: "Missing token" });
      socket.disconnect(true);
      return;
    }

    let user: JwtPayload;
    try {
      user = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    } catch {
      socket.emit("error:auth", { error: "Invalid token" });
      socket.disconnect(true);
      return;
    }

    socket.join("global");
    socket.join(`user:${user.sub}`);

    socket.on("chat:join", (channelRaw: unknown) => {
      if (typeof channelRaw !== "string" || !CHANNEL_PATTERN.test(channelRaw)) {
        socket.emit("error:chat", { error: "Invalid channel" });
        return;
      }

      socket.join(channelRaw);
    });

    socket.on("chat:send", async (payload: ChatPayload) => {
      if (!allowSocketEvent(socket, "chat:send")) {
        socket.emit("error:chat", { error: "Rate limit exceeded for chat:send" });
        return;
      }

      if (!payload || typeof payload.channel !== "string" || typeof payload.message !== "string") {
        socket.emit("error:chat", { error: "Invalid payload" });
        return;
      }

      const moderation = moderateMessage(payload.message);
      if (!moderation.ok) {
        socket.emit("error:chat", { error: moderation.reason });
        return;
      }

      const msg = {
        id: randomUUID(),
        channel: payload.channel,
        senderUserId: user.sub,
        senderName: user.username,
        message: moderation.clean,
        createdAt: new Date().toISOString()
      };

      await run(
        `
          INSERT INTO chat_messages (id, channel, sender_user_id, message, created_at)
          VALUES (?, ?, ?, ?, ?)
        `,
        [msg.id, msg.channel, msg.senderUserId, msg.message, msg.createdAt]
      );

      io.to(payload.channel).emit("chat:message", msg);
    });

    socket.on("matchmaking:enqueue", (payload: MatchmakingPayload) => {
      if (!allowSocketEvent(socket, "matchmaking:enqueue")) {
        socket.emit("error:matchmaking", { error: "Rate limit exceeded for matchmaking:enqueue" });
        return;
      }

      if (!payload || !["casual", "ranked"].includes(payload.mode)) {
        socket.emit("error:matchmaking", { error: "Invalid mode" });
        return;
      }

      if (!["mobile", "pc"].includes(payload.platform)) {
        socket.emit("error:matchmaking", { error: "Invalid platform" });
        return;
      }

      if (!Number.isFinite(payload.rating)) {
        socket.emit("error:matchmaking", { error: "Invalid rating" });
        return;
      }

      const queued = matchmaking.enqueue({
        socketId: socket.id,
        userId: user.sub,
        mode: payload.mode,
        platform: payload.platform,
        crossplay: payload.crossplay ?? false,
        rating: payload.rating
      });

      if (!queued.matched) {
        socket.emit("matchmaking:queued", { mode: payload.mode, platform: payload.platform });
        return;
      }

      const ownMatchPayload = {
        mode: payload.mode,
        opponentUserId: queued.opponent.userId
      };

      socket.emit("matchmaking:match-found", ownMatchPayload);

      const opponentSocket = io.sockets.sockets.get(queued.opponent.socketId);
      if (opponentSocket) {
        opponentSocket.emit("matchmaking:match-found", {
          mode: payload.mode,
          opponentUserId: user.sub
        });
      }
    });

    socket.on("disconnect", () => {
      matchmaking.dequeueSocket(socket.id);
    });
  });

  return io;
}
