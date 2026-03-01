export function applySelectionRules(current: string[], nodeId: string, multi: boolean): string[] {
  if (!multi) {
    return [nodeId];
  }

  if (current.includes(nodeId)) {
    return current.filter((id) => id !== nodeId);
  }

  return [...current, nodeId];
}
