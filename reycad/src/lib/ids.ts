export function createId(prefix = "node"): string {
  const random = Math.random().toString(36).slice(2, 9);
  return `${prefix}_${random}`;
}
