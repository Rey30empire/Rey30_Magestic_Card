import { Box3, PerspectiveCamera, Vector3 } from "three";

export function frameBounds(camera: PerspectiveCamera, bounds: Box3): void {
  const size = new Vector3();
  bounds.getSize(size);
  const center = new Vector3();
  bounds.getCenter(center);

  const radius = Math.max(size.x, size.y, size.z) * 0.85;
  const distance = radius / Math.tan((camera.fov * Math.PI) / 360);

  camera.position.set(center.x + distance, center.y + distance * 0.8, center.z + distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}
