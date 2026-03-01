import type { PrimitiveType } from "../scenegraph/types";

export type ParsedDslCommand =
  | { kind: "create"; primitive: PrimitiveType }
  | { kind: "unknown" };

export function parseSimpleDsl(input: string): ParsedDslCommand {
  const normalized = input.trim().toLowerCase();
  if (normalized.includes("box")) {
    return { kind: "create", primitive: "box" };
  }
  if (normalized.includes("cylinder")) {
    return { kind: "create", primitive: "cylinder" };
  }
  if (normalized.includes("sphere")) {
    return { kind: "create", primitive: "sphere" };
  }
  if (normalized.includes("cone")) {
    return { kind: "create", primitive: "cone" };
  }
  if (normalized.includes("text")) {
    return { kind: "create", primitive: "text" };
  }
  return { kind: "unknown" };
}
