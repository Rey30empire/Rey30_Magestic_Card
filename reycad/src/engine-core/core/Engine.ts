import { EngineEntity } from "./Entity";
import { EngineSceneGraph } from "./SceneGraph";
import type { ComponentType, EngineComponent } from "./Component";
import type { EngineSystem, EngineUpdateStage } from "./System";

const STAGE_ORDER: Record<EngineUpdateStage, number> = {
  input: 0,
  script: 1,
  physics: 2,
  animation: 3,
  render: 4
};

export class Engine {
  private readonly entitiesById = new Map<string, EngineEntity>();
  private readonly sceneGraph = new EngineSceneGraph();
  private readonly systems: EngineSystem[] = [];
  private elapsedTime = 0;

  createEntity(parentId: string | null = null, id?: string): EngineEntity {
    const entity = new EngineEntity(id);
    this.entitiesById.set(entity.id, entity);
    this.sceneGraph.addNode(entity.id, parentId);
    return entity;
  }

  deleteEntity(entityId: string): string[] {
    const removed = this.sceneGraph.removeNode(entityId);
    for (const id of removed) {
      this.entitiesById.delete(id);
    }
    return removed;
  }

  reparentEntity(entityId: string, parentId: string | null): void {
    if (!this.entitiesById.has(entityId)) {
      return;
    }
    if (parentId && !this.entitiesById.has(parentId)) {
      return;
    }
    this.sceneGraph.reparent(entityId, parentId);
  }

  addSystem(system: EngineSystem): void {
    this.systems.push(system);
    this.systems.sort((a, b) => {
      const stageDiff = STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage];
      if (stageDiff !== 0) {
        return stageDiff;
      }
      return a.priority - b.priority;
    });
  }

  removeSystem(systemId: string): boolean {
    const index = this.systems.findIndex((item) => item.id === systemId);
    if (index < 0) {
      return false;
    }
    this.systems.splice(index, 1);
    return true;
  }

  update(deltaTime: number): void {
    if (!Number.isFinite(deltaTime) || deltaTime <= 0) {
      return;
    }

    this.elapsedTime += deltaTime;
    const entities = this.getEntities();

    for (const system of this.systems) {
      if (!system.enabled) {
        continue;
      }
      system.update({
        deltaTime,
        elapsedTime: this.elapsedTime,
        engine: this,
        entities
      });
    }
  }

  getEntity(entityId: string): EngineEntity | undefined {
    return this.entitiesById.get(entityId);
  }

  getEntities(): EngineEntity[] {
    return [...this.entitiesById.values()];
  }

  getRoots(): string[] {
    return this.sceneGraph.getRoots();
  }

  getChildren(entityId: string): string[] {
    return this.sceneGraph.getChildren(entityId);
  }

  getParent(entityId: string): string | null {
    return this.sceneGraph.getParent(entityId);
  }

  queryByComponent(type: ComponentType): EngineEntity[] {
    return this.getEntities().filter((entity) => entity.hasComponent(type));
  }

  queryByComponents(types: ComponentType[]): EngineEntity[] {
    if (types.length === 0) {
      return this.getEntities();
    }
    return this.getEntities().filter((entity) => types.every((type) => entity.hasComponent(type)));
  }

  getComponent<T extends EngineComponent>(entityId: string, type: ComponentType): T | undefined {
    const entity = this.entitiesById.get(entityId);
    if (!entity) {
      return undefined;
    }
    return entity.getComponent<T>(type);
  }
}
