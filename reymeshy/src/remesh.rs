use crate::MeshData;
use std::collections::HashSet;

fn triangle_area2(ax: f32, ay: f32, az: f32, bx: f32, by: f32, bz: f32, cx: f32, cy: f32, cz: f32) -> f32 {
    let abx = bx - ax;
    let aby = by - ay;
    let abz = bz - az;
    let acx = cx - ax;
    let acy = cy - ay;
    let acz = cz - az;
    let cross_x = aby * acz - abz * acy;
    let cross_y = abz * acx - abx * acz;
    let cross_z = abx * acy - aby * acx;
    (cross_x * cross_x + cross_y * cross_y + cross_z * cross_z).sqrt()
}

fn vertex_xyz(vertices: &[f32], index: usize) -> (f32, f32, f32) {
    let base = index * 3;
    (vertices[base], vertices[base + 1], vertices[base + 2])
}

pub fn auto_remesh(mesh: MeshData) -> MeshData {
    if !mesh.has_valid_vertex_layout() {
        return MeshData {
            vertices: vec![],
            indices: vec![],
            uvs: vec![],
        };
    }

    let vertex_count = mesh.vertex_count();
    let mut cleaned_indices = Vec::with_capacity(mesh.indices.len());
    let mut seen = HashSet::<[u32; 3]>::new();

    for tri in mesh.indices.chunks(3) {
        if tri.len() < 3 {
            continue;
        }
        let a = tri[0] as usize;
        let b = tri[1] as usize;
        let c = tri[2] as usize;

        if a >= vertex_count || b >= vertex_count || c >= vertex_count {
            continue;
        }
        if a == b || b == c || a == c {
            continue;
        }

        let mut normalized = [tri[0], tri[1], tri[2]];
        normalized.sort_unstable();
        if !seen.insert(normalized) {
            continue;
        }

        let (ax, ay, az) = vertex_xyz(&mesh.vertices, a);
        let (bx, by, bz) = vertex_xyz(&mesh.vertices, b);
        let (cx, cy, cz) = vertex_xyz(&mesh.vertices, c);
        if triangle_area2(ax, ay, az, bx, by, bz, cx, cy, cz) < 1e-7 {
            continue;
        }

        cleaned_indices.extend_from_slice(tri);
    }

    MeshData {
        vertices: mesh.vertices,
        indices: cleaned_indices,
        uvs: mesh.uvs,
    }
}
