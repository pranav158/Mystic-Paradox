//! Test-only helpers: a one-thread mock HTTP backend and JWT-shaped tokens, shared by the launcher's routing tests.
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;

pub(crate) struct Recorded {
    pub(crate) method: String,
    pub(crate) path: String,
    /// Request line, headers and body, lower-cased.
    pub(crate) text: String,
}

/// A one-thread HTTP server that answers `replies` in order (status, JSON body) and records each request.
pub(crate) fn mock_backend(replies: Vec<(u16, String)>) -> (String, mpsc::Receiver<Recorded>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        for (status, body) in replies {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut raw = Vec::new();
            let mut chunk = [0u8; 4096];
            let header_end = loop {
                let read = stream.read(&mut chunk).unwrap_or(0);
                if read == 0 {
                    break raw.len();
                }
                raw.extend_from_slice(&chunk[..read]);
                if let Some(at) = raw.windows(4).position(|window| window == b"\r\n\r\n") {
                    break at + 4;
                }
            };
            let head = String::from_utf8_lossy(&raw[..header_end]).to_lowercase();
            let wanted = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            while raw.len() < header_end + wanted {
                let read = stream.read(&mut chunk).unwrap_or(0);
                if read == 0 {
                    break;
                }
                raw.extend_from_slice(&chunk[..read]);
            }
            let text = String::from_utf8_lossy(&raw).to_lowercase();
            let mut parts = text.split_whitespace();
            let method = parts.next().unwrap_or("").to_string();
            let path = parts.next().unwrap_or("").to_string();
            let _ = sender.send(Recorded { method, path, text });
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    (base, receiver)
}

/// A JWT-shaped access token whose claims `access_token_lifetime` can read (12 minutes).
pub(crate) fn access_token(label: &str) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let claims = URL_SAFE_NO_PAD.encode(r#"{"iat":1000,"exp":1720}"#);
    format!("h.{claims}.{label}")
}

pub(crate) fn session_json(label: &str, refresh: &str) -> String {
    serde_json::json!({
        "accessToken": access_token(label),
        "refreshToken": refresh,
        "account": {
            "userId": format!("user-{label}"), "displayName": "Slayer", "email": "x@example.com",
            "discordLinked": false, "status": "active", "approvalStatus": "approved", "needsUsername": false
        }
    })
    .to_string()
}

pub(crate) fn error_json(code: &str) -> String {
    serde_json::json!({ "error": { "code": code, "message": "x" } }).to_string()
}
