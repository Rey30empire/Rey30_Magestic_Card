const blockedWords = ["hack", "cheat", "estafa", "scam", "fraude"];

export function moderateMessage(message: string): { ok: boolean; reason?: string; clean: string } {
  const clean = message.trim();

  if (clean.length < 1) {
    return { ok: false, reason: "Empty message", clean };
  }

  if (clean.length > 250) {
    return { ok: false, reason: "Message too long", clean };
  }

  const normalized = clean.toLowerCase();
  const found = blockedWords.find((word) => normalized.includes(word));

  if (found) {
    return { ok: false, reason: `Blocked word detected: ${found}`, clean };
  }

  return { ok: true, clean };
}
