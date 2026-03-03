use std::io::{self, Read};
use std::process::ExitCode;

use reymeshy::{run_cleanup_pipeline, MeshData};

fn read_stdin() -> Result<String, String> {
    let mut buffer = String::new();
    io::stdin()
        .read_to_string(&mut buffer)
        .map_err(|error| format!("failed to read stdin: {error}"))?;
    Ok(buffer)
}

fn print_json_error(message: &str) {
    eprintln!(r#"{{"error":"{message}"}}"#);
}

fn main() -> ExitCode {
    let command = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "cleanup".to_string());

    if command != "cleanup" {
        print_json_error("unsupported_command");
        return ExitCode::from(2);
    }

    let raw_input = match read_stdin() {
        Ok(raw) => raw,
        Err(error) => {
            print_json_error(&error.replace('"', "'"));
            return ExitCode::from(2);
        }
    };

    let mesh = match serde_json::from_str::<MeshData>(&raw_input) {
        Ok(mesh) => mesh,
        Err(error) => {
            print_json_error(&format!("invalid_mesh_json: {error}").replace('"', "'"));
            return ExitCode::from(2);
        }
    };

    let result = run_cleanup_pipeline(mesh);
    match serde_json::to_string(&result) {
        Ok(json) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            print_json_error(&format!("serialize_failed: {error}").replace('"', "'"));
            ExitCode::from(2)
        }
    }
}
