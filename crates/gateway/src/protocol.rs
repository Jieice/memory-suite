use anyhow::{Context, Result, bail};
use brotli::Decompressor;
use flate2::read::ZlibDecoder;
use serde_json::json;
use std::io::Read;

const HEADER_LEN: usize = 16;
const PROTOCOL_JSON: u16 = 1;
const PROTOCOL_HEARTBEAT: u16 = 1;
const PROTOCOL_DEFLATE: u16 = 2;
const PROTOCOL_BROTLI: u16 = 3;
const OP_HEARTBEAT: u32 = 2;
const OP_HEARTBEAT_REPLY: u32 = 3;
const OP_AUTH: u32 = 7;
const OP_AUTH_REPLY: u32 = 8;
const OP_MESSAGE: u32 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PacketHeader {
    pub packet_len: u32,
    pub header_len: u16,
    pub protocol_version: u16,
    pub operation: u32,
    pub sequence: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthReplyPayload {
    pub code: Option<i64>,
    pub message: Option<String>,
    pub raw: String,
}

impl AuthReplyPayload {
    pub fn is_success(&self) -> bool {
        self.code == Some(0)
    }

    pub fn rejection_detail(&self) -> String {
        let code = self
            .code
            .map(|value| value.to_string())
            .unwrap_or_else(|| "<none>".into());
        let message = self.message.as_deref().unwrap_or("<none>");
        format!("code={code} message={message} raw={}", self.raw)
    }
}

impl DecodedPacket {
    pub fn accepts_first_frame(&self) -> bool {
        match self {
            DecodedPacket::HeartbeatReply { .. } => true,
            DecodedPacket::AuthReply { payload } => payload.is_success(),
            DecodedPacket::JsonMessage { .. } => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodedPacket {
    HeartbeatReply { popularity: u32 },
    AuthReply { payload: AuthReplyPayload },
    JsonMessage { operation: u32, payload: String },
}

pub fn encode_auth_packet(room_id: u64, uid: u64, buvid: &str, token: &str) -> Result<Vec<u8>> {
    let payload = serde_json::to_vec(&json!({
        "uid": uid,
        "roomid": room_id,
        "protover": 1,
        "platform": "web",
        "type": 2,
        "buvid": buvid,
        "key": token,
    }))
    .context("serialize auth payload")?;

    encode_packet(OP_AUTH, PROTOCOL_JSON, &payload)
}

pub fn encode_heartbeat_packet() -> Result<Vec<u8>> {
    encode_packet(OP_HEARTBEAT, PROTOCOL_HEARTBEAT, b"[object Object]")
}

pub fn decode_packets(bytes: &[u8]) -> Result<Vec<DecodedPacket>> {
    let mut decoded = Vec::new();
    decode_packets_inner(bytes, &mut decoded)?;
    Ok(decoded)
}

fn decode_packets_inner(bytes: &[u8], decoded: &mut Vec<DecodedPacket>) -> Result<()> {
    let mut offset = 0_usize;

    while offset < bytes.len() {
        let remaining = &bytes[offset..];
        if remaining.len() < HEADER_LEN {
            if is_ignorable_tail(remaining) {
                break;
            }
            bail!("incomplete bilibili packet header");
        }

        let packet_len = read_u32(&remaining[..4])? as usize;
        let header_len = read_u16(&remaining[4..6])? as usize;
        let protocol_version = read_u16(&remaining[6..8])?;
        let operation = read_u32(&remaining[8..12])?;

        if packet_len < HEADER_LEN || header_len != HEADER_LEN {
            bail!("invalid bilibili packet lengths");
        }
        if packet_len > remaining.len() {
            bail!("incomplete bilibili packet body");
        }

        let body = &remaining[HEADER_LEN..packet_len];
        match (protocol_version, operation) {
            (_, OP_HEARTBEAT_REPLY) if body.len() >= 4 => {
                decoded.push(DecodedPacket::HeartbeatReply {
                    popularity: read_u32(&body[..4])?,
                });
            }
            (0 | 1, OP_AUTH_REPLY) => {
                let raw = String::from_utf8(body.to_vec())
                    .context("decode bilibili auth reply payload as utf-8")?;
                let parsed = serde_json::from_str::<serde_json::Value>(&raw).ok();
                decoded.push(DecodedPacket::AuthReply {
                    payload: AuthReplyPayload {
                        code: parsed
                            .as_ref()
                            .and_then(|value| value.get("code"))
                            .and_then(serde_json::Value::as_i64),
                        message: parsed
                            .as_ref()
                            .and_then(|value| value.get("message").or_else(|| value.get("msg")))
                            .and_then(serde_json::Value::as_str)
                            .map(ToOwned::to_owned),
                        raw,
                    },
                });
            }
            (0 | 1, OP_MESSAGE) | (0 | 1, OP_AUTH) => {
                decoded.push(DecodedPacket::JsonMessage {
                    operation,
                    payload: String::from_utf8(body.to_vec())
                        .context("decode bilibili json payload as utf-8")?,
                });
            }
            (PROTOCOL_DEFLATE, OP_MESSAGE | OP_AUTH_REPLY) => {
                let inflated = inflate_zlib(body)?;
                decode_packets_inner(&inflated, decoded)?;
            }
            (PROTOCOL_BROTLI, OP_MESSAGE | OP_AUTH_REPLY) => {
                let inflated = inflate_brotli(body)?;
                decode_packets_inner(&inflated, decoded)?;
            }
            _ => {}
        }

        offset += packet_len;
    }

    Ok(())
}

fn is_ignorable_tail(bytes: &[u8]) -> bool {
    bytes.is_empty()
        || bytes == b"[object Object]"
        || bytes.iter().all(|byte| byte.is_ascii_whitespace())
}

fn inflate_zlib(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut decoder = ZlibDecoder::new(bytes);
    let mut inflated = Vec::new();
    decoder
        .read_to_end(&mut inflated)
        .context("inflate bilibili zlib payload")?;
    Ok(inflated)
}

fn inflate_brotli(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut decoder = Decompressor::new(bytes, 4096);
    let mut inflated = Vec::new();
    decoder
        .read_to_end(&mut inflated)
        .context("inflate bilibili brotli payload")?;
    Ok(inflated)
}

fn encode_packet(operation: u32, protocol_version: u16, payload: &[u8]) -> Result<Vec<u8>> {
    let packet_len = (HEADER_LEN + payload.len()) as u32;
    let header = PacketHeader {
        packet_len,
        header_len: HEADER_LEN as u16,
        protocol_version,
        operation,
        sequence: 1,
    };

    let mut bytes = Vec::with_capacity(packet_len as usize);
    bytes.extend_from_slice(&header.packet_len.to_be_bytes());
    bytes.extend_from_slice(&header.header_len.to_be_bytes());
    bytes.extend_from_slice(&header.protocol_version.to_be_bytes());
    bytes.extend_from_slice(&header.operation.to_be_bytes());
    bytes.extend_from_slice(&header.sequence.to_be_bytes());
    bytes.extend_from_slice(payload);
    Ok(bytes)
}

fn read_u16(bytes: &[u8]) -> Result<u16> {
    Ok(u16::from_be_bytes(
        bytes.try_into().context("read u16 from bilibili packet")?,
    ))
}

fn read_u32(bytes: &[u8]) -> Result<u32> {
    Ok(u32::from_be_bytes(
        bytes.try_into().context("read u32 from bilibili packet")?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::ZlibEncoder};
    use std::io::Write;

    #[test]
    fn encodes_auth_packet_with_expected_header_and_body() {
        let packet = encode_auth_packet(123, 456, "buvid-x", "token-x").expect("auth packet");
        assert_eq!(
            read_u32(&packet[..4]).expect("packet len") as usize,
            packet.len()
        );
        assert_eq!(
            read_u16(&packet[4..6]).expect("header len"),
            HEADER_LEN as u16
        );
        assert_eq!(read_u32(&packet[8..12]).expect("op"), OP_AUTH);

        let body = std::str::from_utf8(&packet[HEADER_LEN..]).expect("utf-8 body");
        assert!(body.contains("\"roomid\":123"));
        assert!(body.contains("\"uid\":456"));
        assert!(body.contains("\"protover\":1"));
        assert!(!body.contains("\"clientver\""));
        assert!(body.contains("\"buvid\":\"buvid-x\""));
        assert!(body.contains("\"key\":\"token-x\""));
    }

    #[test]
    fn encodes_heartbeat_packet() {
        let packet = encode_heartbeat_packet().expect("heartbeat packet");
        assert_eq!(read_u32(&packet[8..12]).expect("op"), OP_HEARTBEAT);
        assert_eq!(&packet[HEADER_LEN..], b"[object Object]");
    }

    #[test]
    fn decodes_heartbeat_reply_and_json_message_packets() {
        let heartbeat = {
            let mut packet = Vec::new();
            packet.extend_from_slice(&(20_u32).to_be_bytes());
            packet.extend_from_slice(&(16_u16).to_be_bytes());
            packet.extend_from_slice(&(1_u16).to_be_bytes());
            packet.extend_from_slice(&(OP_HEARTBEAT_REPLY).to_be_bytes());
            packet.extend_from_slice(&(1_u32).to_be_bytes());
            packet.extend_from_slice(&(321_u32).to_be_bytes());
            packet
        };

        let json_body = br#"{"cmd":"DANMU_MSG","info":["x","hello"]}"#;
        let json_packet = encode_packet(OP_MESSAGE, 1, json_body).expect("json packet");

        let mut combined = heartbeat;
        combined.extend_from_slice(&json_packet);

        let decoded = decode_packets(&combined).expect("decode packets");
        assert_eq!(
            decoded,
            vec![
                DecodedPacket::HeartbeatReply { popularity: 321 },
                DecodedPacket::JsonMessage {
                    operation: OP_MESSAGE,
                    payload: String::from_utf8(json_body.to_vec()).expect("json body"),
                },
            ]
        );
    }

    #[test]
    fn ignores_heartbeat_echo_tail_after_reply() {
        let mut packet = Vec::new();
        packet.extend_from_slice(&(20_u32).to_be_bytes());
        packet.extend_from_slice(&(16_u16).to_be_bytes());
        packet.extend_from_slice(&(1_u16).to_be_bytes());
        packet.extend_from_slice(&(OP_HEARTBEAT_REPLY).to_be_bytes());
        packet.extend_from_slice(&(0_u32).to_be_bytes());
        packet.extend_from_slice(&(1_u32).to_be_bytes());
        packet.extend_from_slice(b"[object Object]");

        let decoded = decode_packets(&packet).expect("decode heartbeat reply with echo tail");
        assert_eq!(
            decoded,
            vec![DecodedPacket::HeartbeatReply { popularity: 1 }]
        );
    }

    #[test]
    fn decodes_zlib_wrapped_message_packets() {
        let inner_json = br#"{"cmd":"DANMU_MSG","info":["x","hello zipped"]}"#;
        let inner_packet = encode_packet(OP_MESSAGE, 0, inner_json).expect("inner packet");

        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder
            .write_all(&inner_packet)
            .expect("write inner packet to zlib encoder");
        let compressed = encoder.finish().expect("finish zlib encoding");
        let outer_packet = encode_packet(OP_MESSAGE, PROTOCOL_DEFLATE, &compressed)
            .expect("outer compressed packet");

        let decoded = decode_packets(&outer_packet).expect("decode compressed packets");
        assert_eq!(
            decoded,
            vec![DecodedPacket::JsonMessage {
                operation: OP_MESSAGE,
                payload: String::from_utf8(inner_json.to_vec()).expect("inner json"),
            }]
        );
    }

    #[test]
    fn decodes_brotli_wrapped_message_packets() {
        let inner_json = br#"{"cmd":"DANMU_MSG","info":["x","hello brotli"]}"#;
        let inner_packet = encode_packet(OP_MESSAGE, 0, inner_json).expect("inner packet");

        let mut compressed = Vec::new();
        {
            let mut compressor = brotli::CompressorWriter::new(&mut compressed, 4096, 5, 22);
            compressor
                .write_all(&inner_packet)
                .expect("write inner packet to brotli encoder");
        }
        let outer_packet = encode_packet(OP_MESSAGE, PROTOCOL_BROTLI, &compressed)
            .expect("outer brotli packet");

        let decoded = decode_packets(&outer_packet).expect("decode brotli packets");
        assert_eq!(
            decoded,
            vec![DecodedPacket::JsonMessage {
                operation: OP_MESSAGE,
                payload: String::from_utf8(inner_json.to_vec()).expect("inner json"),
            }]
        );
    }
}
