use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::{Message, client::IntoClientRequest, http::header::{COOKIE, ORIGIN, REFERER, USER_AGENT}}};

use crate::protocol::{DecodedPacket, decode_packets, encode_auth_packet};

fn first_frame_proves_auth(decoded: &[DecodedPacket]) -> bool {
    decoded.iter().any(|packet| match packet {
        DecodedPacket::HeartbeatReply { .. } => true,
        DecodedPacket::AuthReply { payload } => payload.is_success(),
        DecodedPacket::JsonMessage { .. } => false,
    })
}

fn browser_user_agent() -> &'static str {
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0"
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionBootstrap {
    pub room_id: u64,
    pub uid: u64,
    pub buvid: String,
    pub token: String,
    pub address: String,
    pub cookie: Option<String>,
}

pub async fn connect_authenticated(
    bootstrap: &SessionBootstrap,
) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>> {
    let referer = format!("https://live.bilibili.com/{}", bootstrap.room_id);
    let mut request = bootstrap
        .address
        .as_str()
        .into_client_request()
        .with_context(|| format!("native stage=build_handshake address={}", bootstrap.address))?;
    request.headers_mut().insert(USER_AGENT, browser_user_agent().parse()?);
    request.headers_mut().insert(ORIGIN, "https://live.bilibili.com".parse()?);
    request.headers_mut().insert(REFERER, referer.parse()?);
    if let Some(cookie) = bootstrap.cookie.as_deref().filter(|value| !value.trim().is_empty()) {
        request.headers_mut().insert(COOKIE, cookie.parse()?);
    }

    let (mut socket, _) = connect_async(request)
        .await
        .with_context(|| format!("native stage=connect address={}", bootstrap.address))?;

    socket
        .send(Message::Binary(
            encode_auth_packet(
                bootstrap.room_id,
                bootstrap.uid,
                &bootstrap.buvid,
                &bootstrap.token,
            )?
            .into(),
        ))
        .await
        .with_context(|| format!("native stage=send_auth address={}", bootstrap.address))?;

    Ok(socket)
}

pub async fn handshake_and_read_once(bootstrap: &SessionBootstrap) -> Result<Vec<DecodedPacket>> {
    let mut socket = connect_authenticated(bootstrap).await?;

    while let Some(message) = socket.next().await {
        match message.with_context(|| format!("native stage=read_first_frame address={}", bootstrap.address))? {
            Message::Binary(bytes) => {
                let decoded = decode_packets(&bytes)
                    .with_context(|| format!("native stage=decode_first_frame address={}", bootstrap.address))?;
                if first_frame_proves_auth(&decoded) {
                    return Ok(decoded);
                }
                bail!("native stage=read_first_frame_rejected address={} decoded={decoded:?}", bootstrap.address);
            }
            Message::Close(frame) => {
                let detail = frame
                    .map(|frame| {
                        if frame.reason.is_empty() {
                            format!("code={}", frame.code)
                        } else {
                            format!("code={} reason={}", frame.code, frame.reason)
                        }
                    })
                    .unwrap_or_else(|| "code=<none>".into());
                bail!("native stage=read_first_frame_closed address={} {}", bootstrap.address, detail);
            }
            _ => {}
        }
    }

    bail!("native stage=read_first_frame_ended address={}", bootstrap.address)
}

#[cfg(test)]
mod tests {
    use anyhow::Result;
    use futures_util::{SinkExt, StreamExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_hdr_async, tungstenite::Message};

    use super::*;
    #[tokio::test]
    async fn performs_auth_then_decodes_binary_reply_without_immediate_heartbeat() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept tcp");
            let request_cell = std::sync::Arc::new(std::sync::Mutex::new(None));
            let request_cell_clone = request_cell.clone();
            let mut socket = accept_hdr_async(stream, move |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                *request_cell_clone.lock().expect("lock request cell") = Some(request.clone());
                Ok(response)
            }).await.expect("accept ws");

            let request = request_cell.lock().expect("lock recorded request").clone().expect("recorded request");
            assert_eq!(request.headers().get("origin").and_then(|value| value.to_str().ok()), Some("https://live.bilibili.com"));
            assert_eq!(request.headers().get("referer").and_then(|value| value.to_str().ok()), Some("https://live.bilibili.com/123"));
            assert_eq!(request.headers().get("cookie").and_then(|value| value.to_str().ok()), Some("SESSDATA=test; bili_jct=test_jct;"));
            assert!(request.headers().get("user-agent").and_then(|value| value.to_str().ok()).unwrap_or_default().contains("Mozilla/5.0"));

            let auth = socket
                .next()
                .await
                .expect("auth frame")
                .expect("auth message");

            let auth_bytes = match auth {
                Message::Binary(bytes) => bytes,
                other => panic!("expected binary auth, got {other:?}"),
            };

            let auth_body = std::str::from_utf8(&auth_bytes[16..]).expect("auth utf-8 body");
            assert!(auth_body.contains("\"roomid\":123"));
            assert!(auth_body.contains("\"uid\":456"));
            assert!(auth_body.contains("\"key\":\"token-client\""));

            let heartbeat_reply = {
                let mut packet = Vec::new();
                packet.extend_from_slice(&(20_u32).to_be_bytes());
                packet.extend_from_slice(&(16_u16).to_be_bytes());
                packet.extend_from_slice(&(1_u16).to_be_bytes());
                packet.extend_from_slice(&(3_u32).to_be_bytes());
                packet.extend_from_slice(&(1_u32).to_be_bytes());
                packet.extend_from_slice(&(9527_u32).to_be_bytes());
                packet
            };

            let json_payload = br#"{"cmd":"DANMU_MSG","info":["x","hello ws"]}"#;
            let json_packet = {
                let mut packet = Vec::new();
                let packet_len = 16 + json_payload.len() as u32;
                packet.extend_from_slice(&packet_len.to_be_bytes());
                packet.extend_from_slice(&(16_u16).to_be_bytes());
                packet.extend_from_slice(&(1_u16).to_be_bytes());
                packet.extend_from_slice(&(5_u32).to_be_bytes());
                packet.extend_from_slice(&(1_u32).to_be_bytes());
                packet.extend_from_slice(json_payload);
                packet
            };

            let mut response = heartbeat_reply;
            response.extend_from_slice(&json_packet);
            socket
                .send(Message::Binary(response.into()))
                .await
                .expect("send ws response");
            socket.close(None).await.expect("close ws");
        });

        let decoded = handshake_and_read_once(&SessionBootstrap {
            room_id: 123,
            uid: 456,
            buvid: "buvid-client".into(),
            token: "token-client".into(),
            address: format!("ws://{addr}"),
            cookie: Some("SESSDATA=test; bili_jct=test_jct;".into()),
        })
        .await?;

        assert_eq!(
            decoded,
            vec![
                DecodedPacket::HeartbeatReply { popularity: 9527 },
                DecodedPacket::JsonMessage {
                    operation: 5,
                    payload: "{\"cmd\":\"DANMU_MSG\",\"info\":[\"x\",\"hello ws\"]}".into(),
                },
            ]
        );

        server.await.expect("server task");
        Ok(())
    }

    #[tokio::test]
    async fn rejects_first_frame_without_auth_acceptance_signal() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept tcp");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("accept ws");

            let _auth = socket.next().await.expect("auth frame").expect("auth message");

            let json_payload = br#"{"cmd":"NOTICE_MSG","msg":"not accepted"}"#;
            let json_packet = {
                let mut packet = Vec::new();
                let packet_len = 16 + json_payload.len() as u32;
                packet.extend_from_slice(&packet_len.to_be_bytes());
                packet.extend_from_slice(&(16_u16).to_be_bytes());
                packet.extend_from_slice(&(1_u16).to_be_bytes());
                packet.extend_from_slice(&(5_u32).to_be_bytes());
                packet.extend_from_slice(&(1_u32).to_be_bytes());
                packet.extend_from_slice(json_payload);
                packet
            };

            socket
                .send(Message::Binary(json_packet.into()))
                .await
                .expect("send ws response");
            socket.close(None).await.expect("close ws");
        });

        let error = handshake_and_read_once(&SessionBootstrap {
            room_id: 123,
            uid: 456,
            buvid: "buvid-client".into(),
            token: "token-client".into(),
            address: format!("ws://{addr}"),
            cookie: Some("SESSDATA=test;".into()),
        })
        .await
        .expect_err("first frame should be rejected");
        assert!(error.to_string().contains("native stage=read_first_frame_rejected"));

        server.await.expect("server task");
        Ok(())
    }

    #[tokio::test]
    async fn rejects_auth_reply_first_frame_with_nonzero_code() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept tcp");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("accept ws");

            let _auth = socket.next().await.expect("auth frame").expect("auth message");

            let auth_reply_payload = br#"{"code":-101,"message":"auth failed"}"#;
            let auth_reply_packet = {
                let mut packet = Vec::new();
                let packet_len = 16 + auth_reply_payload.len() as u32;
                packet.extend_from_slice(&packet_len.to_be_bytes());
                packet.extend_from_slice(&(16_u16).to_be_bytes());
                packet.extend_from_slice(&(1_u16).to_be_bytes());
                packet.extend_from_slice(&(8_u32).to_be_bytes());
                packet.extend_from_slice(&(1_u32).to_be_bytes());
                packet.extend_from_slice(auth_reply_payload);
                packet
            };

            socket
                .send(Message::Binary(auth_reply_packet.into()))
                .await
                .expect("send auth reply response");
            socket.close(None).await.expect("close ws");
        });

        let error = handshake_and_read_once(&SessionBootstrap {
            room_id: 123,
            uid: 456,
            buvid: "buvid-client".into(),
            token: "token-client".into(),
            address: format!("ws://{addr}"),
            cookie: Some("SESSDATA=test;".into()),
        })
        .await
        .expect_err("nonzero auth reply should be rejected");
        assert!(error.to_string().contains("native stage=read_first_frame_rejected"));
        assert!(error.to_string().contains("auth failed"));

        server.await.expect("server task");
        Ok(())
    }
}
