pub mod compression;
pub mod lod;
pub mod remesh;
pub mod uv;

use serde::{Deserialize, Serialize};

pub use compression::{compress_mesh, CompressionResult};
pub use lod::optimize_lod;
pub use remesh::auto_remesh;
pub use uv::auto_uv;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeshData {
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
    #[serde(default)]
    pub uvs: Vec<f32>,
}

impl MeshData {
    pub fn vertex_count(&self) -> usize {
        self.vertices.len() / 3
    }

    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    pub fn has_valid_vertex_layout(&self) -> bool {
        self.vertices.len() % 3 == 0 && !self.vertices.is_empty()
    }

    pub fn has_valid_uv_layout(&self) -> bool {
        self.uvs.is_empty() || self.uvs.len() == self.vertex_count() * 2
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PipelineOutput {
    pub remeshed: MeshData,
    pub uv_unwrapped: MeshData,
    pub lod_optimized: MeshData,
}

pub fn run_cleanup_pipeline(input: MeshData) -> PipelineOutput {
    let remeshed = auto_remesh(input);
    let uv_unwrapped = auto_uv(remeshed.clone());
    let lod_optimized = optimize_lod(uv_unwrapped.clone());
    PipelineOutput {
        remeshed,
        uv_unwrapped,
        lod_optimized,
    }
}

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn run_cleanup_pipeline_json(json_input: &str) -> String {
    let parsed = serde_json::from_str::<MeshData>(json_input);
    let Ok(mesh) = parsed else {
        return r#"{"error":"invalid_mesh_json"}"#.to_string();
    };
    let result = run_cleanup_pipeline(mesh);
    serde_json::to_string(&result).unwrap_or_else(|_| r#"{"error":"pipeline_serialize_failed"}"#.to_string())
}

#[cfg(test)]
mod tests {
    use super::{auto_remesh, auto_uv, optimize_lod, run_cleanup_pipeline, MeshData};

    #[test]
    fn remesh_drops_out_of_range_and_degenerate_triangles() {
        let mesh = MeshData {
            vertices: vec![
                0.0, 0.0, 0.0, // 0
                1.0, 0.0, 0.0, // 1
                0.0, 1.0, 0.0, // 2
            ],
            indices: vec![0, 1, 2, 0, 0, 2, 0, 1, 99],
            uvs: vec![],
        };

        let cleaned = auto_remesh(mesh);
        assert_eq!(cleaned.indices, vec![0, 1, 2]);
    }

    #[test]
    fn auto_uv_generates_uvs_when_missing() {
        let mesh = MeshData {
            vertices: vec![
                -1.0, 0.0, -1.0, // 0
                1.0, 0.0, -1.0,  // 1
                1.0, 0.0, 1.0,   // 2
                -1.0, 0.0, 1.0,  // 3
            ],
            indices: vec![0, 1, 2, 0, 2, 3],
            uvs: vec![],
        };

        let with_uv = auto_uv(mesh);
        assert_eq!(with_uv.uvs.len(), 8);
    }

    #[test]
    fn optimize_lod_reduces_dense_mesh_triangles() {
        let mesh = MeshData {
            vertices: vec![
                0.0, 0.0, 0.0, // 0
                1.0, 0.0, 0.0, // 1
                0.0, 1.0, 0.0, // 2
                1.0, 1.0, 0.0, // 3
                2.0, 0.0, 0.0, // 4
                2.0, 1.0, 0.0, // 5
            ],
            indices: vec![
                0, 1, 2, // t0
                1, 3, 2, // t1
                1, 4, 3, // t2
                4, 5, 3, // t3
            ],
            uvs: vec![],
        };
        let optimized = optimize_lod(mesh);
        assert!(optimized.triangle_count() < 4);
    }

    #[test]
    fn cleanup_pipeline_is_deterministic() {
        let mesh = MeshData {
            vertices: vec![
                0.0, 0.0, 0.0, // 0
                1.0, 0.0, 0.0, // 1
                0.0, 1.0, 0.0, // 2
                1.0, 1.0, 0.0, // 3
            ],
            indices: vec![0, 1, 2, 1, 3, 2],
            uvs: vec![],
        };

        let a = run_cleanup_pipeline(mesh.clone());
        let b = run_cleanup_pipeline(mesh);
        assert_eq!(a, b);
    }
}
