import engineApi from "../../engine/api/engineApi";
import type { PrimitiveType } from "../../engine/scenegraph/types";

export type PythonBridge = {
  call: (tool: string, args: Record<string, unknown>) => unknown;
};

export function createPythonBridge(): PythonBridge {
  return {
    call(tool, args) {
      if (tool === "create_primitive") {
        const primitive = (args.primitive as PrimitiveType | undefined) ?? "box";
        const params = (args.params as Record<string, unknown> | undefined) ?? {};
        const transform = (args.transform as { position?: [number, number, number] } | undefined) ?? {};
        const materialId = args.materialId as string | undefined;

        return engineApi.createPrimitive(primitive, params, transform, materialId);
      }

      if (tool === "set_grid") {
        const snap = args.snap as number | undefined;
        const angleSnap = args.angleSnap as number | undefined;
        const size = args.size as number | undefined;
        engineApi.setGrid({ snap, angleSnap, size });
        return true;
      }

      if (tool === "get_selection") {
        return engineApi.getSelection();
      }

      throw new Error(`Unsupported python tool: ${tool}`);
    }
  };
}
