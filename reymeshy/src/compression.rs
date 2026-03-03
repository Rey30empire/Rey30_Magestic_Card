use crate::MeshData;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompressionResult {
    pub mesh: MeshData,
    pub ratio_estimate: f32,
    pub strategy: &'static str,
}

pub fn compress_mesh(mesh: MeshData) -> CompressionResult {
    let vertex_bytes = mesh.vertices.len() * std::mem::size_of::<f32>();
    let index_bytes = mesh.indices.len() * std::mem::size_of::<u32>();
    let uv_bytes = mesh.uvs.len() * std::mem::size_of::<f32>();
    let uncompressed_total = vertex_bytes + index_bytes + uv_bytes;

    let ratio_estimate = if uncompressed_total == 0 {
        1.0
    } else {
        // Conservative placeholder ratio for meshopt/topology compression phase.
        0.62
    };

    CompressionResult {
        mesh,
        ratio_estimate,
        strategy: "placeholder_meshopt_pack_v1",
    }
}
