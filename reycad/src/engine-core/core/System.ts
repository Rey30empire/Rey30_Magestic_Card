import type { EngineEntity } from "./Entity";
import type { Engine } from "./Engine";
import type { ComponentType } from "./Component";

export type EngineUpdateStage = "input" | "script" | "physics" | "animation" | "render";

export type EngineUpdateContext = {
  deltaTime: number;
  elapsedTime: number;
  engine: Engine;
  entities: ReadonlyArray<EngineEntity>;
};

export interface EngineSystem {
  readonly id: string;
  readonly stage: EngineUpdateStage;
  readonly priority: number;
  readonly requiredComponents: readonly ComponentType[];
  enabled: boolean;
  update(context: EngineUpdateContext): void;
}

export abstract class BaseSystem implements EngineSystem {
  readonly id: string;
  readonly stage: EngineUpdateStage;
  readonly priority: number;
  readonly requiredComponents: readonly ComponentType[];
  enabled = true;

  protected constructor(id: string, stage: EngineUpdateStage, priority = 0, requiredComponents: readonly ComponentType[] = []) {
    this.id = id;
    this.stage = stage;
    this.priority = priority;
    this.requiredComponents = [...requiredComponents];
  }

  abstract update(context: EngineUpdateContext): void;
}
