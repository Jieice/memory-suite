use std::path::PathBuf;

pub(crate) fn default_config_path() -> PathBuf {
    let workspace_root = workspace_root();
    let explicit = workspace_root.join("config").join("app.toml");
    if explicit.exists() {
        explicit
    } else {
        workspace_root.join("config").join("app.toml.example")
    }
}

pub(crate) fn resolve_runtime_path(path: &str) -> PathBuf {
    let candidate = PathBuf::from(path);
    if candidate.is_absolute() {
        candidate
    } else {
        workspace_root().join(candidate)
    }
}

pub(crate) fn web_dist_dir() -> PathBuf {
    workspace_root().join("apps").join("web").join("dist")
}

pub(crate) fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

pub(crate) fn tools_root() -> PathBuf {
    workspace_root().join("data").join("tools")
}

pub(crate) fn overlay_pages_dir() -> PathBuf {
    workspace_root().join("apps").join("web").join("overlays")
}

pub(crate) fn live2d_assets_dir() -> PathBuf {
    let zh_hans_runtime = workspace_root()
        .join("Liver2d")
        .join("hiyori_zh-Hans")
        .join("hiyori_pro")
        .join("runtime");
    if zh_hans_runtime.exists() {
        return zh_hans_runtime;
    }

    workspace_root()
        .join("Liver2d")
        .join("hiyori_pro_zh")
        .join("runtime")
}

pub(crate) fn pixi_vendor_dir() -> PathBuf {
    workspace_root()
        .join("apps")
        .join("web")
        .join("node_modules")
        .join("pixi.js")
        .join("dist")
        .join("browser")
}

pub(crate) fn live2d_vendor_dir() -> PathBuf {
    workspace_root()
        .join("apps")
        .join("web")
        .join("node_modules")
        .join("pixi-live2d-display")
        .join("dist")
}

pub(crate) fn live2d_core_vendor_dir() -> PathBuf {
    workspace_root()
        .join("runtime")
        .join("overlay-vendor")
        .join("live2d-core")
}

#[cfg(test)]
mod tests {
    use super::{resolve_runtime_path, workspace_root};

    #[test]
    fn resolves_relative_runtime_paths_from_workspace_root() {
        assert_eq!(
            resolve_runtime_path("./python"),
            workspace_root().join("./python")
        );
        assert_eq!(
            resolve_runtime_path("runtime/memory-suite.db"),
            workspace_root().join("runtime/memory-suite.db")
        );
    }
}
