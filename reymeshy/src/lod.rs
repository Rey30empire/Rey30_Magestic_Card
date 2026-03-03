use crate::MeshData;
use std::collections::HashMap;

fn choose_step(triangle_count: usize) -> usize {
    if triangle_count > 200_000 {
        8
    } else if triangle_count > 60_000 {
        4
    } else if triangle_count > 10_000 {
        2
    } else if triangle_count >= 4 {
        2
    } else {
        1
    }
}

pub fn optimize_lod(mesh: MeshData) -> MeshData {
    if !mesh.has_valid_vertex_layout() || mesh.indices.len() < 3 {
        return mesh;
    }

    let tri_count = mesh.triangle_count();
    let step = choose_step(tri_count);
    if step <= 1 {
        return mesh;
    }

    let mut kept_indices: Vec<u32> = Vec::with_capacity(mesh.indices.len() / step);
    for (tri_i, tri) in mesh.indices.chunks(3).enumerate() {
        if tri.len() < 3 {
            continue;
        }
        if tri_i % step == 0 {
            kept_indices.extend_from_slice(tri);
        }
    }

    if kept_indices.len() < 3 {
        return mesh;
    }

    let mut remap = HashMap::<u32, u32>::new();
    let mut next_index = 0u32;
    let mut new_vertices = Vec::<f32>::new();
    let mut new_uvs = Vec::<f32>::new();
    let has_uvs = mesh.has_valid_uv_layout() && !mesh.uvs.is_empty();

    let mut remapped_indices = Vec::<u32>::with_capacity(kept_indices.len());
    for old in kept_indices {
        let mapped = if let Some(existing) = remap.get(&old) {
            *existing
        } else {
            let old_usize = old as usize;
            let base = old_usize * 3;
            if base + 2 >= mesh.vertices.len() {
                continue;
            }
            new_vertices.extend_from_slice(&mesh.vertices[base..base + 3]);
            if has_uvs {
                let uv_base = old_usize * 2;
                if uv_base + 1 < mesh.uvs.len() {
                    new_uvs.extend_from_slice(&mesh.uvs[uv_base..uv_base + 2]);
                } else {
                    new_uvs.extend_from_slice(&[0.0, 0.0]);
                }
            }
            let current = next_index;
            remap.insert(old, current);
            next_index += 1;
            current
        };
        remapped_indices.push(mapped);
    }

    MeshData {
        vertices: new_vertices,
        indices: remapped_indices,
        uvs: if has_uvs { new_uvs } else { vec![] },
    }
}
