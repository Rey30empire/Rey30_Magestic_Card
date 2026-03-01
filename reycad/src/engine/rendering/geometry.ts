import { BoxGeometry, ConeGeometry, CylinderGeometry, SphereGeometry, ExtrudeGeometry, Shape } from "three";
import type { RenderPrimitive } from "../scenegraph/evaluator";

export function buildGeometryFromPrimitive(item: RenderPrimitive) {
  switch (item.primitive) {
    case "box":
      return new BoxGeometry(item.params.w, item.params.h, item.params.d);
    case "cylinder":
      return new CylinderGeometry(item.params.rTop, item.params.rBottom, item.params.h, item.params.radialSegments);
    case "sphere":
      return new SphereGeometry(item.params.r, item.params.widthSegments, item.params.heightSegments);
    case "cone":
      return new ConeGeometry(item.params.r, item.params.h, item.params.radialSegments);
    case "text": {
      const width = Math.max(2, item.params.text.length * item.params.size * 0.6);
      const height = Math.max(1, item.params.size);
      const shape = new Shape();
      shape.moveTo(-width / 2, -height / 2);
      shape.lineTo(width / 2, -height / 2);
      shape.lineTo(width / 2, height / 2);
      shape.lineTo(-width / 2, height / 2);
      shape.lineTo(-width / 2, -height / 2);
      return new ExtrudeGeometry(shape, { depth: Math.max(0.4, item.params.height), bevelEnabled: false });
    }
    default:
      return new BoxGeometry(10, 10, 10);
  }
}
