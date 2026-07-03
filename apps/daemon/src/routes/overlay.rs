use axum::{
    http::StatusCode,
    response::{Html, IntoResponse},
};

use crate::paths::overlay_pages_dir;

pub(crate) async fn live2d_overlay() -> impl IntoResponse {
    render_overlay_page("live2d.html")
}

pub(crate) async fn danmaku_overlay() -> impl IntoResponse {
    render_overlay_page("danmaku.html")
}

fn render_overlay_page(file_name: &str) -> impl IntoResponse {
    let path = overlay_pages_dir().join(file_name);
    match std::fs::read_to_string(&path) {
        Ok(html) => (StatusCode::OK, Html(html)).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Html(format!(
                "<!doctype html><html><body><pre>overlay page missing: {} ({})</pre></body></html>",
                path.display(),
                error
            )),
        )
            .into_response(),
    }
}
