use crate::MeshData;

fn bounds_xy(vertices: &[f32]) -> (f32, f32, f32, f32) {
    let mut min_x = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut min_z = f32::INFINITY;
    let mut max_z = f32::NEG_INFINITY;

    for point in vertices.chunks(3) {
        if point.len() < 3 {
            continue;
        }
        min_x = min_x.min(point[0]);
        max_x = max_x.max(point[0]);
        min_z = min_z.min(point[2]);
        max_z = max_z.max(point[2]);
    }

    if !min_x.is_finite() || !max_x.is_finite() || !min_z.is_finite() || !max_z.is_finite() {
        return (0.0, 1.0, 0.0, 1.0);
    }
    if (max_x - min_x).abs() < 1e-6 {
        max_x = min_x + 1.0;
    }
    if (max_z - min_z).abs() < 1e-6 {
        max_z = min_z + 1.0;
    }

    (min_x, max_x, min_z, max_z)
}

pub fn auto_uv(mesh: MeshData) -> MeshData {
    if !mesh.has_valid_vertex_layout() {
        return MeshData {
            vertices: vec![],
            indices: vec![],
            uvs: vec![],
        };
    }

    if mesh.has_valid_uv_layout() && !mesh.uvs.is_empty() {
        return mesh;
    }

    let (min_x, max_x, min_z, max_z) = bounds_xy(&mesh.vertices);
    let width = max_x - min_x;
    let depth = max_z - min_z;

    let mut uvs = Vec::with_capacity(mesh.vertex_count() * 2);
    for point in mesh.vertices.chunks(3) {
        if point.len() < 3 {
            continue;
        }
        let u = (point[0] - min_x) / width;
        let v = (point[2] - min_z) / depth;
        uvs.push(u.clamp(0.0, 1.0));
        uvs.push(v.clamp(0.0, 1.0));
    }

    MeshData {
        vertices: mesh.vertices,
        indices: mesh.indices,
        uvs,
    }
}
