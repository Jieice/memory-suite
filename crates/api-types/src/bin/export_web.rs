use std::path::PathBuf;

fn main() -> std::io::Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    let output = root.join("apps").join("web").join("src").join("generated").join("api.ts");
    api_types::write_typescript_bindings(output)
}
