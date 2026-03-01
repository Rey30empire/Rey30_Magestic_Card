import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { all, auditLog, get, run } from "../db/sqlite";
import { authRequired } from "../middleware/auth";
import { requireNoAbuseBlock } from "../middleware/abuse-block";
import { recordAbuseRiskEvent } from "../services/abuse-detection";
import { sha256 } from "../utils/hash";

type ListingRow = {
  id: string;
  card_id: string;
  seller_user_id: string;
  kind: string;
  price_credits: number;
  status: "active" | "sold" | "cancelled";
  created_at: string;
  seller_name?: string;
  card_name?: string;
  card_rarity?: string;
};

type UserPoints = {
  creative_points: number;
};

type CardOwnerRow = {
  id: string;
  owner_user_id: string;
  status: string;
};

const createListingSchema = z.object({
  cardId: z.string().min(5),
  priceCredits: z.number().int().min(1).max(1000)
});

function isSqliteUniqueConstraint(error: unknown, target: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed") && message.includes(target);
}

async function safeRollback(): Promise<void> {
  try {
    await run("ROLLBACK");
  } catch {
    // Ignore rollback errors when transaction was not started.
  }
}

async function hasActiveListingForCard(cardId: string): Promise<boolean> {
  const existing = await get<{ id: string }>("SELECT id FROM market_listings WHERE card_id = ? AND status = 'active' LIMIT 1", [cardId]);
  return Boolean(existing?.id);
}

export const marketplaceRouter = Router();
const abuseGuard = requireNoAbuseBlock();

function recordMarketplaceRiskEvent(
  userId: string | undefined,
  eventKey: string,
  metadata: Record<string, unknown>,
  requestId?: string | null,
  traceId?: string | null
): void {
  if (!userId) {
    return;
  }

  void recordAbuseRiskEvent({
    userId,
    source: "marketplace",
    eventKey,
    metadata,
    requestId: requestId ?? null,
    traceId: traceId ?? null
  }).catch((error) => {
    console.error("[abuse-risk] failed to record marketplace event", error);
  });
}

marketplaceRouter.get("/listings", async (_req, res) => {
  const rows = await all<ListingRow>(
    `
      SELECT
        l.id,
        l.card_id,
        l.seller_user_id,
        l.kind,
        l.price_credits,
        l.status,
        l.created_at,
        u.username AS seller_name,
        c.name AS card_name,
        c.rarity AS card_rarity
      FROM market_listings l
      INNER JOIN users u ON u.id = l.seller_user_id
      INNER JOIN cards c ON c.id = l.card_id
      WHERE l.status = 'active'
      ORDER BY l.created_at DESC
      LIMIT 200
    `
  );

  res.json({
    items: rows.map((row) => ({
      id: row.id,
      cardId: row.card_id,
      sellerUserId: row.seller_user_id,
      sellerName: row.seller_name,
      cardName: row.card_name,
      cardRarity: row.card_rarity,
      kind: row.kind,
      priceCredits: row.price_credits,
      status: row.status,
      createdAt: row.created_at
    }))
  });
});

marketplaceRouter.post("/listings", authRequired, abuseGuard, async (req, res) => {
  const parsed = createListingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid listing payload", details: parsed.error.flatten() });
    return;
  }

  const card = await get<CardOwnerRow>("SELECT id, owner_user_id, status FROM cards WHERE id = ?", [parsed.data.cardId]);
  if (!card) {
    res.status(404).json({ error: "Card not found" });
    return;
  }

  if (card.status !== "published") {
    res.status(409).json({ error: "Only published cards can be listed" });
    return;
  }

  if (card.owner_user_id !== req.user!.id) {
    res.status(403).json({ error: "Card is not active in your inventory" });
    return;
  }

  if (await hasActiveListingForCard(parsed.data.cardId)) {
    recordMarketplaceRiskEvent(
      req.user?.id,
      "marketplace.duplicate-active-listing",
      { cardId: parsed.data.cardId, priceCredits: parsed.data.priceCredits },
      req.requestId,
      req.traceId
    );
    res.status(409).json({ error: "This card already has an active listing" });
    return;
  }

  const listingId = randomUUID();
  const now = new Date().toISOString();

  try {
    await run("BEGIN TRANSACTION");

    const lockInventory = await run("UPDATE inventory SET active = 0 WHERE user_id = ? AND card_id = ? AND active = 1", [
      req.user!.id,
      parsed.data.cardId
    ]);
    if (lockInventory.changes === 0) {
      throw new Error("Card is already listed or unavailable in inventory");
    }

    await run(
      `
        INSERT INTO market_listings (id, card_id, seller_user_id, kind, price_credits, status, created_at)
        VALUES (?, ?, ?, 'card', ?, 'active', ?)
      `,
      [listingId, parsed.data.cardId, req.user!.id, parsed.data.priceCredits, now]
    );

    await run("COMMIT");
  } catch (error) {
    await safeRollback();

    const message = error instanceof Error ? error.message : "Failed to create listing";
    if (message === "Card is already listed or unavailable in inventory") {
      recordMarketplaceRiskEvent(
        req.user?.id,
        "marketplace.listing-unavailable",
        { cardId: parsed.data.cardId },
        req.requestId,
        req.traceId
      );
      res.status(409).json({ error: message });
      return;
    }

    if (
      isSqliteUniqueConstraint(error, "market_listings.card_id") ||
      isSqliteUniqueConstraint(error, "idx_market_listings_active_card_unique")
    ) {
      recordMarketplaceRiskEvent(
        req.user?.id,
        "marketplace.duplicate-active-listing",
        { cardId: parsed.data.cardId },
        req.requestId,
        req.traceId
      );
      res.status(409).json({ error: "This card already has an active listing" });
      return;
    }

    res.status(500).json({ error: message });
    return;
  }

  await auditLog(req.user!.id, "marketplace.create-listing", {
    listingId,
    cardId: parsed.data.cardId,
    priceCredits: parsed.data.priceCredits
  });

  res.status(201).json({
    listingId,
    cardId: parsed.data.cardId,
    priceCredits: parsed.data.priceCredits,
    status: "active"
  });
});

marketplaceRouter.post("/listings/:id/buy", authRequired, abuseGuard, async (req, res) => {
  const listingId = String(req.params.id);
  const listing = await get<ListingRow>("SELECT * FROM market_listings WHERE id = ?", [listingId]);

  if (!listing) {
    res.status(404).json({ error: "Listing not found" });
    return;
  }

  if (listing.status !== "active") {
    recordMarketplaceRiskEvent(
      req.user?.id,
      "marketplace.invalid-buy-state",
      { listingId: listing.id, status: listing.status },
      req.requestId,
      req.traceId
    );
    res.status(409).json({
      error: "Listing is not available for purchase",
      status: listing.status
    });
    return;
  }

  if (listing.seller_user_id === req.user!.id) {
    res.status(400).json({ error: "Cannot buy your own listing" });
    return;
  }

  const buyer = await get<UserPoints>("SELECT creative_points FROM users WHERE id = ?", [req.user!.id]);
  if (!buyer || buyer.creative_points < listing.price_credits) {
    res.status(402).json({
      error: "Not enough creative points",
      needed: listing.price_credits,
      current: buyer?.creative_points ?? 0
    });
    return;
  }

  const now = new Date().toISOString();
  const licenseHash = sha256(`${listing.id}:${req.user!.id}:${now}`);

  try {
    await run("BEGIN TRANSACTION");

    const claimed = await run("UPDATE market_listings SET status = 'sold' WHERE id = ? AND status = 'active'", [listing.id]);
    if (claimed.changes === 0) {
      throw new Error("Listing was already purchased or unavailable");
    }

    const cardOwner = await get<{ owner_user_id: string; status: string }>("SELECT owner_user_id, status FROM cards WHERE id = ?", [
      listing.card_id
    ]);
    if (!cardOwner || cardOwner.owner_user_id !== listing.seller_user_id || cardOwner.status !== "published") {
      throw new Error("Listing owner mismatch");
    }

    const debit = await run(
      "UPDATE users SET creative_points = creative_points - ? WHERE id = ? AND creative_points >= ?",
      [listing.price_credits, req.user!.id, listing.price_credits]
    );
    if (debit.changes === 0) {
      throw new Error("Not enough creative points");
    }

    await run("UPDATE users SET creative_points = creative_points + ? WHERE id = ?", [listing.price_credits, listing.seller_user_id]);

    const transfer = await run("UPDATE cards SET owner_user_id = ? WHERE id = ? AND owner_user_id = ?", [
      req.user!.id,
      listing.card_id,
      listing.seller_user_id
    ]);
    if (transfer.changes === 0) {
      throw new Error("Listing owner mismatch");
    }

    await run("UPDATE inventory SET active = 0 WHERE user_id = ? AND card_id = ?", [listing.seller_user_id, listing.card_id]);

    const reactivateBuyer = await run(
      `
        UPDATE inventory
        SET active = 1, source = 'marketplace', acquired_at = ?
        WHERE user_id = ? AND card_id = ? AND active = 0
      `,
      [now, req.user!.id, listing.card_id]
    );

    if (reactivateBuyer.changes === 0) {
      await run(
        `
          INSERT INTO inventory (id, user_id, card_id, source, active, acquired_at)
          VALUES (?, ?, ?, 'marketplace', 1, ?)
        `,
        [randomUUID(), req.user!.id, listing.card_id, now]
      );
    }

    await run(
      `
        INSERT INTO licenses (id, listing_id, buyer_user_id, license_hash, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      [randomUUID(), listing.id, req.user!.id, licenseHash, now]
    );

    await run("COMMIT");
  } catch (error) {
    await run("ROLLBACK");
    const message = error instanceof Error ? error.message : "Failed to complete marketplace purchase";
    if (message === "Not enough creative points") {
      res.status(402).json({
        error: "Not enough creative points",
        needed: listing.price_credits
      });
      return;
    }

    if (message === "Listing was already purchased or unavailable") {
      recordMarketplaceRiskEvent(
        req.user?.id,
        "marketplace.buy-conflict",
        { listingId: listing.id },
        req.requestId,
        req.traceId
      );
      res.status(409).json({ error: message });
      return;
    }

    if (message === "Listing owner mismatch") {
      recordMarketplaceRiskEvent(
        req.user?.id,
        "marketplace.owner-mismatch",
        { listingId: listing.id, cardId: listing.card_id },
        req.requestId,
        req.traceId
      );
      res.status(409).json({ error: message });
      return;
    }

    res.status(500).json({ error: message });
    return;
  }

  await auditLog(req.user!.id, "marketplace.buy", {
    listingId: listing.id,
    cardId: listing.card_id,
    sellerUserId: listing.seller_user_id,
    priceCredits: listing.price_credits,
    licenseHash
  });

  const balance = await get<UserPoints>("SELECT creative_points FROM users WHERE id = ?", [req.user!.id]);

  res.json({
    listingId: listing.id,
    cardId: listing.card_id,
    licenseHash,
    creativePointsRemaining: balance?.creative_points ?? 0
  });
});

marketplaceRouter.post("/listings/:id/cancel", authRequired, abuseGuard, async (req, res) => {
  const listingId = String(req.params.id);
  const listing = await get<ListingRow>("SELECT * FROM market_listings WHERE id = ? AND status = 'active'", [listingId]);
  if (!listing) {
    recordMarketplaceRiskEvent(
      req.user?.id,
      "marketplace.listing-unavailable",
      { listingId },
      req.requestId,
      req.traceId
    );
    res.status(404).json({ error: "Listing not found or unavailable" });
    return;
  }

  if (listing.seller_user_id !== req.user!.id) {
    res.status(403).json({ error: "Only the seller can cancel listing" });
    return;
  }

  try {
    await run("BEGIN TRANSACTION");

    const cancelled = await run("UPDATE market_listings SET status = 'cancelled' WHERE id = ? AND status = 'active'", [listing.id]);
    if (cancelled.changes === 0) {
      throw new Error("Listing not found or unavailable");
    }

    const cardOwner = await get<{ owner_user_id: string }>("SELECT owner_user_id FROM cards WHERE id = ?", [listing.card_id]);
    if (cardOwner?.owner_user_id === req.user!.id) {
      const reactivated = await run(
        `
          UPDATE inventory
          SET active = 1, source = 'listing-cancelled', acquired_at = ?
          WHERE user_id = ? AND card_id = ? AND active = 0
        `,
        [new Date().toISOString(), req.user!.id, listing.card_id]
      );

      if (reactivated.changes === 0) {
        await run(
          `
            INSERT INTO inventory (id, user_id, card_id, source, active, acquired_at)
            VALUES (?, ?, ?, 'listing-cancelled', 1, ?)
          `,
          [randomUUID(), req.user!.id, listing.card_id, new Date().toISOString()]
        );
      }
    }

    await run("COMMIT");
  } catch (error) {
    await safeRollback();
    const message = error instanceof Error ? error.message : "Failed to cancel listing";
    if (message === "Listing not found or unavailable") {
      res.status(404).json({ error: message });
      return;
    }

    res.status(500).json({ error: message });
    return;
  }

  await auditLog(req.user!.id, "marketplace.cancel-listing", { listingId: listing.id });

  res.json({ listingId: listing.id, status: "cancelled" });
});
