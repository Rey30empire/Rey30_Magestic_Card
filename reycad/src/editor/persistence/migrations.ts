import { createProject } from "../../engine/scenegraph/factory";
import type { Project } from "../../engine/scenegraph/types";

export const CURRENT_PROJECT_VERSION = 1;

export function migrateProject(project: Project): Project {
  if (project.version === CURRENT_PROJECT_VERSION) {
    return project;
  }

  const fallback = createProject();
  return {
    ...fallback,
    ...project,
    version: CURRENT_PROJECT_VERSION
  };
}
