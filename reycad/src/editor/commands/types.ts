import type { EditorData } from "../state/types";

export interface Command {
  id: string;
  name: string;
  do(state: EditorData): EditorData;
  undo(state: EditorData): EditorData;
}
