use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::Message,
};

use crate::protocol::{DecodedPacket, decode_packets, encode_auth_packet, encode_heartbeat_packet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionBootstrap {
    pub room_id: u64,
    pub uid: u64,
    pub buvid: String,
    pub token: String,
    pub address: String,
}

pub async fn connect_authenticated(
    bootstrap: &SessionBootstrap,
) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>> {
    let (mut socket, _) = connect_async(&bootstrap.address)
        .await
        .with_context(|| format!("connect websocket {}", bootstrap.address))?;

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
        .context("send bilibili auth packet")?;

    socket
        .send(Message::Binary(encode_heartbeat_packet()?.into()))
        .await
        .context("send bilibili heartbeat packet")?;

    Ok(socket)
}

pub async fn handshake_and_read_once(bootstrap: &SessionBootstrap) -> Result<Vec<DecodedPacket>> {
    let mut socket = connect_authenticated(bootstrap).await?;

    while let Some(message) = socket.next().await {
        match message.context("read websocket frame")? {
            Message::Binary(bytes) => return decode_packets(&bytes),
            Message::Close(_) => bail!("websocket closed before any binary packet"),
            _ => {}
        }
    }

    bail!("websocket ended before any binary packet")
}

#[cfg(test)]
mod tests {
    use anyhow::Result;
    use futures_util::{SinkExt, StreamExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    use super::*;
    #[tokio::test]
    async fn performs_auth_and_heartbeat_then_decodes_binary_reply() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept tcp");
            let mut socket = accept_async(stream).await.expect("accept ws");

            let auth = socket
                .next()
                .await
                .expect("auth frame")
                .expect("auth message");
            let heartbeat = socket
                .next()
                .await
                .expect("heartbeat frame")
                .expect("heartbeat message");

            let auth_bytes = match auth {
                Message::Binary(bytes) => bytes,
                other => panic!("expected binary auth, got {other:?}"),
            };
            let heartbeat_bytes = match heartbeat {
                Message::Binary(bytes) => bytes,
                other => panic!("expected binary heartbeat, got {other:?}"),
            };

            let auth_body = std::str::from_utf8(&auth_bytes[16..]).expect("auth utf-8 body");
            assert!(auth_body.contains("\"roomid\":123"));
            assert!(auth_body.contains("\"uid\":456"));
            assert!(auth_body.contains("\"key\":\"token-client\""));
            assert_eq!(&heartbeat_bytes[16..], b"[object Object]");

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
}
