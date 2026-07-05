use std::sync::Arc;

use axum::{
    Router,
    routing::{get, post},
};
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

mod paths;
mod routes;
mod state;
mod tools;
mod workers;

pub use state::{AppState, AppStateOptions, bootstrap_state, bootstrap_state_with_shutdown};

use paths::{
    live2d_assets_dir, live2d_core_vendor_dir, live2d_vendor_dir, pixi_vendor_dir, web_dist_dir,
};
use routes::character::{
    generate_diary_entry, generate_highlight_reel, generate_short_content, get_character_clips,
    get_character_diary, get_character_energy, get_character_mood, get_character_thoughts,
    set_character_mood,
};
use routes::chat::{chat, get_session_topics, interrupt_session};
use routes::config::{
    runtime_config, test_runtime_llm_config, test_runtime_stt_config, test_runtime_tts_config,
    update_runtime_llm_config, update_runtime_stt_config, update_runtime_tts_config,
};
use routes::danmaku::{
    bootstrap_danmaku, danmaku_native_connect_once, danmaku_native_probe,
    danmaku_native_session_start, danmaku_source, danmaku_state, disconnect_danmaku,
    gateway_danmaku, update_danmaku_source,
};
use routes::live2d::{
    ack_live2d_speech, cancel_live2d_speech, get_live2d_speech, live2d_config, live2d_emotion,
    live2d_state, live2d_subtitle, next_live2d_speech,
};
use routes::overlay::{danmaku_overlay, live2d_overlay};
use routes::persona::{persona_config, persona_state};
use routes::runtime::{
    chat_latency, get_audience_state, health, knowledge_catalog, list_adapters,
    list_session_messages, runtime_overview, shutdown_runtime, start_adapter,
};
use routes::scene::{get_scene_context, reaction_event, scene_context, scene_event, scene_suggest};
use routes::stt::stt_transcribe;
use routes::tools::{execute_tool, list_tool_executions, list_tool_manifests};
use routes::tts::{tts_audio_file, tts_speak};
use routes::ws::{overlay_ws, runtime_ws, session_ws};
use workers::spawn_danmaku_batch_processor;

pub fn build_router(state: AppState) -> Router {
    let state_arc = Arc::new(state.clone());
    spawn_danmaku_batch_processor(state_arc);
    Router::new()
        .route("/api/health", get(health))
        .route("/api/chat", post(chat))
        .route("/api/sessions/{session_id}/interrupt", post(interrupt_session))
        .route("/api/runtime/config", get(runtime_config))
        .route("/api/runtime/config/llm", post(update_runtime_llm_config))
        .route("/api/runtime/config/llm/test", post(test_runtime_llm_config))
        .route("/api/runtime/config/tts", post(update_runtime_tts_config))
        .route("/api/runtime/config/tts/test", post(test_runtime_tts_config))
        .route("/api/runtime/config/stt", post(update_runtime_stt_config))
        .route("/api/runtime/config/stt/test", post(test_runtime_stt_config))
        .route("/api/runtime/overview", get(runtime_overview))
        .route("/api/runtime/chat-latency", get(chat_latency))
        .route("/api/runtime/shutdown", post(shutdown_runtime))
        .route("/api/knowledge/catalog", get(knowledge_catalog))
        .route("/api/tools/manifests", get(list_tool_manifests))
        .route("/api/tools/execute", post(execute_tool))
        .route("/api/tools/executions", get(list_tool_executions))
        .route("/api/runtime/adapters", get(list_adapters))
        .route(
            "/api/runtime/adapters/{adapter_id}/start",
            post(start_adapter),
        )
        .route(
            "/api/sessions/{session_id}/messages",
            get(list_session_messages),
        )
        .route("/api/tts/speak", post(tts_speak))
        .route("/api/stt/transcribe", post(stt_transcribe))
        .route("/api/audio/{request_id}", get(tts_audio_file))
        .route("/api/live2d/state", get(live2d_state))
        .route("/api/live2d/subtitle", post(live2d_subtitle))
        .route("/api/live2d/emotion", post(live2d_emotion))
        .route("/api/live2d/config", post(live2d_config))
        .route("/api/live2d/speech/next", get(next_live2d_speech))
        .route("/api/live2d/speech/{speech_id}", get(get_live2d_speech))
        .route("/api/live2d/speech/cancel", post(cancel_live2d_speech))
        .route(
            "/api/live2d/speech/{speech_id}/ack",
            post(ack_live2d_speech),
        )
        .route(
            "/api/danmaku/source",
            get(danmaku_source).post(update_danmaku_source),
        )
        .route("/api/danmaku/state", get(danmaku_state))
        .route("/api/danmaku/bootstrap", post(bootstrap_danmaku))
        .route("/api/danmaku/native-probe", post(danmaku_native_probe))
        .route(
            "/api/danmaku/native-connect-once",
            post(danmaku_native_connect_once),
        )
        .route(
            "/api/danmaku/native-session/start",
            post(danmaku_native_session_start),
        )
        .route("/api/danmaku/disconnect", post(disconnect_danmaku))
        .route("/api/gateway/danmaku", post(gateway_danmaku))
        .route("/api/persona/state", get(persona_state))
        .route("/api/persona/config", post(persona_config))
        .route("/api/scene/event", post(scene_event))
        .route("/api/scene/context", post(scene_context))
        .route("/api/scene/context", get(get_scene_context))
        .route("/api/scene/suggest", get(scene_suggest))
        .route("/api/character/diary", get(get_character_diary))
        .route("/api/character/diary", post(generate_diary_entry))
        .route("/api/character/thoughts", get(get_character_thoughts))
        .route("/api/character/clips", get(get_character_clips))
        .route(
            "/api/character/generate-short",
            post(generate_short_content),
        )
        .route("/api/character/mood", get(get_character_mood))
        .route("/api/character/mood", post(set_character_mood))
        .route("/api/character/energy", get(get_character_energy))
        .route("/api/audience", get(get_audience_state))
        .route("/api/events/reaction", post(reaction_event))
        .route("/api/session/topics", get(get_session_topics))
        .route(
            "/api/character/highlight-reel",
            post(generate_highlight_reel),
        )
        .route("/ws/session/{session_id}", get(session_ws))
        .route("/ws/runtime", get(runtime_ws))
        .route("/ws/overlay", get(overlay_ws))
        .route("/overlay/live2d", get(live2d_overlay))
        .route("/overlay/danmaku", get(danmaku_overlay))
        .nest_service("/live2d-assets", ServeDir::new(live2d_assets_dir()))
        .nest_service("/overlay-vendor/pixi", ServeDir::new(pixi_vendor_dir()))
        .nest_service("/overlay-vendor/live2d", ServeDir::new(live2d_vendor_dir()))
        .nest_service(
            "/overlay-vendor/live2d-core",
            ServeDir::new(live2d_core_vendor_dir()),
        )
        .fallback_service(
            ServeDir::new(web_dist_dir())
                .not_found_service(ServeFile::new(web_dist_dir().join("index.html"))),
        )
        .with_state(Arc::new(state))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
}
