export type Platform = "mobile" | "pc";
export type MatchMode = "casual" | "ranked";

export type QueueEntry = {
  socketId: string;
  userId: string;
  platform: Platform;
  crossplay: boolean;
  mode: MatchMode;
  rating: number;
  createdAt: number;
};

function platformCompatible(a: QueueEntry, b: QueueEntry): boolean {
  if (a.platform === "pc" || b.platform === "pc") {
    return a.platform === "pc" && b.platform === "pc";
  }

  return true;
}

export class MatchmakingService {
  private readonly queue: QueueEntry[] = [];

  enqueue(entry: Omit<QueueEntry, "createdAt">): { matched: false } | { matched: true; opponent: QueueEntry } {
    const normalized: QueueEntry = {
      ...entry,
      crossplay: entry.platform === "pc" ? false : entry.crossplay,
      createdAt: Date.now()
    };

    this.cleanup();

    const opponentIndex = this.queue.findIndex((q) => {
      if (q.mode !== normalized.mode) {
        return false;
      }

      if (q.userId === normalized.userId) {
        return false;
      }

      if (!platformCompatible(q, normalized)) {
        return false;
      }

      return Math.abs(q.rating - normalized.rating) <= 200;
    });

    if (opponentIndex < 0) {
      this.queue.push(normalized);
      return { matched: false };
    }

    const [opponent] = this.queue.splice(opponentIndex, 1);
    return { matched: true, opponent };
  }

  dequeueSocket(socketId: string): void {
    const idx = this.queue.findIndex((q) => q.socketId === socketId);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
    }
  }

  private cleanup(): void {
    const cutoff = Date.now() - 2 * 60 * 1000;
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      if (this.queue[i].createdAt < cutoff) {
        this.queue.splice(i, 1);
      }
    }
  }
}
