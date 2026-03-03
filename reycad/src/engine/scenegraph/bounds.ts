import { Box3, Vector3 } from "three";
import type { RenderPrimitive } from "./evaluator";

function primitiveSize(item: RenderPrimitive): Vector3 {
  switch (item.primitive) {
    case "box":
      return new Vector3(item.params.w, item.params.h, item.params.d);
    case "cylinder":
      return new Vector3(item.params.rTop * 2, item.params.h, item.params.rTop * 2);
    case "sphere":
      return new Vector3(item.params.r * 2, item.params.r * 2, item.params.r * 2);
    case "cone":
      return new Vector3(item.params.r * 2, item.params.h, item.params.r * 2);
    case "text":
      return new Vector3(item.params.text.length * item.params.size * 0.7, item.params.size, item.params.height);
    case "terrain":
      return new Vector3(item.params.w, Math.max(2, item.params.heightScale * 2), item.params.d);
    default:
      return new Vector3(10, 10, 10);
  }
}

export function computeSelectionBounds(items: RenderPrimitive[]): Box3 | null {
  if (items.length === 0) {
    return null;
  }

  const bounds = new Box3();
  for (const item of items) {
    const size = primitiveSize(item);
    const half = size.clone().multiplyScalar(0.5);
    const center = new Vector3(...item.transform.position);
    bounds.expandByPoint(center.clone().sub(half));
    bounds.expandByPoint(center.clone().add(half));
  }

  return bounds;
}
