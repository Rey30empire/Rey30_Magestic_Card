import { roundToStep } from "../../lib/math";
import type { Transform } from "../scenegraph/types";

export function snapTransform(transform: Transform, snap: number, angleSnapDeg: number): Transform {
  const angleStep = (Math.PI / 180) * angleSnapDeg;

  return {
    position: [
      roundToStep(transform.position[0], snap),
      roundToStep(transform.position[1], snap),
      roundToStep(transform.position[2], snap)
    ],
    rotation: [
      roundToStep(transform.rotation[0], angleStep),
      roundToStep(transform.rotation[1], angleStep),
      roundToStep(transform.rotation[2], angleStep)
    ],
    scale: [
      roundToStep(transform.scale[0], snap),
      roundToStep(transform.scale[1], snap),
      roundToStep(transform.scale[2], snap)
    ]
  };
}
