import { createId } from "../../lib/ids";
import type { ComponentType, EngineComponent } from "./Component";
import { createDefaultTransformComponent } from "./Component";

export class EngineEntity {
  readonly id: string;
  readonly components: Map<ComponentType, EngineComponent>;
  readonly tags: Set<string>;

  constructor(id?: string) {
    this.id = id ?? createId("ent");
    this.components = new Map<ComponentType, EngineComponent>();
    this.tags = new Set<string>();
    this.addComponent(createDefaultTransformComponent());
  }

  addComponent<T extends EngineComponent>(component: T): T {
    this.components.set(component.type, component);
    return component;
  }

  removeComponent(type: ComponentType): boolean {
    if (type === "Transform") {
      return false;
    }
    return this.components.delete(type);
  }

  getComponent<T extends EngineComponent>(type: ComponentType): T | undefined {
    return this.components.get(type) as T | undefined;
  }

  hasComponent(type: ComponentType): boolean {
    return this.components.has(type);
  }
}
