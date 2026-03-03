import type { EngineEntity } from "./Entity";
import type { Engine } from "./Engine";

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
  enabled: boolean;
  update(context: EngineUpdateContext): void;
}

export abstract class BaseSystem implements EngineSystem {
  readonly id: string;
  readonly stage: EngineUpdateStage;
  readonly priority: number;
  enabled = true;

  protected constructor(id: string, stage: EngineUpdateStage, priority = 0) {
    this.id = id;
    this.stage = stage;
    this.priority = priority;
  }

  abstract update(context: EngineUpdateContext): void;
}
