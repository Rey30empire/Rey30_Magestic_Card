export type GizmoMode = "translate" | "rotate" | "scale";

export function modeFromKeyboardKey(key: string): GizmoMode | null {
  if (key.toLowerCase() === "w") {
    return "translate";
  }
  if (key.toLowerCase() === "e") {
    return "rotate";
  }
  if (key.toLowerCase() === "r") {
    return "scale";
  }
  return null;
}
