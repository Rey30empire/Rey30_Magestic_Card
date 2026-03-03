export class EngineSceneGraph {
  private readonly parentById = new Map<string, string | null>();
  private readonly childrenById = new Map<string, Set<string>>();

  addNode(nodeId: string, parentId: string | null): void {
    this.parentById.set(nodeId, parentId);
    if (!this.childrenById.has(nodeId)) {
      this.childrenById.set(nodeId, new Set<string>());
    }
    if (parentId) {
      if (!this.childrenById.has(parentId)) {
        this.childrenById.set(parentId, new Set<string>());
      }
      this.childrenById.get(parentId)?.add(nodeId);
    }
  }

  removeNode(nodeId: string): string[] {
    const removed: string[] = [];
    const stack = [nodeId];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      const children = [...(this.childrenById.get(current) ?? [])];
      for (const child of children) {
        stack.push(child);
      }

      const parentId = this.parentById.get(current);
      if (parentId) {
        this.childrenById.get(parentId)?.delete(current);
      }
      this.parentById.delete(current);
      this.childrenById.delete(current);
      removed.push(current);
    }
    return removed;
  }

  reparent(nodeId: string, parentId: string | null): void {
    const currentParent = this.parentById.get(nodeId);
    if (currentParent) {
      this.childrenById.get(currentParent)?.delete(nodeId);
    }
    this.parentById.set(nodeId, parentId);
    if (parentId) {
      if (!this.childrenById.has(parentId)) {
        this.childrenById.set(parentId, new Set<string>());
      }
      this.childrenById.get(parentId)?.add(nodeId);
    }
  }

  getParent(nodeId: string): string | null {
    return this.parentById.get(nodeId) ?? null;
  }

  getChildren(nodeId: string): string[] {
    return [...(this.childrenById.get(nodeId) ?? [])];
  }

  getRoots(): string[] {
    const roots: string[] = [];
    for (const [nodeId, parentId] of this.parentById.entries()) {
      if (!parentId) {
        roots.push(nodeId);
      }
    }
    return roots;
  }
}
