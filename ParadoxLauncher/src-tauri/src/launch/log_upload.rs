//! What a tester's "Upload logs" sends: which files, how much of each, and what is removed from them first.
//!
//! The game and its servers append to one log per port (`mysticparadox_dll_port<N>.log` beside the game exe) and never
//! rotate it, so a log holds every earlier run too. The launcher records where each log ended when Play started a
//! client or when it started a hosted server (`SessionLogOffsets`, `HostLogStart`); an upload sends from that point,
//! never more than the newest few megabytes of a file, and only the newest logs: the game client of the session and
//! the hosted servers written since it started. Every file is read with full sharing while the game may still write
//! it, cut at its last complete line, and has credential-like values removed before it leaves the PC.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// The game client's and each hosted server's runtime log: the newest bytes of one file.
pub const RUNTIME_LOG_MAX: u64 = 8 * 1024 * 1024;
pub const LAUNCHER_LOG_MAX: u64 = 8 * 1024 * 1024;
pub const CONNECTION_LOG_MAX: u64 = 2 * 1024 * 1024;
pub const REALM_HOST_LOG_MAX: u64 = 2 * 1024 * 1024;
pub const EXIT_LOG_MAX: u64 = 256 * 1024;
pub const CONFIG_MAX: u64 = 256 * 1024;
pub const METADATA_MAX: u64 = 1024 * 1024;
/// The newest hosted-server logs one upload sends (Ramsgate, Training and a hunt or two).
pub const MAX_HOSTED_SERVER_LOGS: usize = 4;
pub const MAX_CONNECTION_LOGS: usize = 20;
/// What one upload sends at most; the server keeps a little more per upload for the manifest.
pub const UPLOAD_BUDGET: u64 = 56 * 1024 * 1024;
/// With no Play session of the account, the host's logs written in this window are sent.
pub const HOST_ONLY_WINDOW_MS: u64 = 24 * 60 * 60 * 1000;
/// Host start records older than this are dropped when a new one is written.
const HOST_RECORD_KEEP_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const HOST_RECORD_MAX: usize = 128;

pub const CLIENT_LOG_NAME: &str = "mysticparadox_dll_port0.log";
pub const SESSION_OFFSETS_FILE: &str = "log-offsets.json";
pub const HOST_OFFSETS_FILE: &str = "host-log-offsets.json";
pub const REALM_HOST_LOG: &str = "realm-host.log";
pub const LAUNCHER_EXIT_LOG: &str = "launcher-exit.log";
pub const MANIFEST_NAME: &str = "upload-manifest.json";
/// The game's user settings files (`%LOCALAPPDATA%\Archon\Saved\Config\WindowsClient`) and their upload names. They can
/// redirect the game's service addresses, which a log alone does not show.
pub const CONFIG_FILES: [(&str, &str); 3] = [
    ("Game.ini", "config-Game.ini"),
    ("Engine.ini", "config-Engine.ini"),
    ("GameUserSettings.ini", "config-GameUserSettings.ini"),
];

// ---- time --------------------------------------------------------------------------------------------------------

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn modified_ms(path: &Path) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|elapsed| elapsed.as_millis() as u64)
}

/// Howard Hinnant's days-from-civil (public domain): (year, month, day) -> days since the Unix epoch.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i64;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Milliseconds of a `YYYY-MM-DDTHH:MM:SS(.mmm)Z` stamp (the launcher's own `iso8601_now`); `None` for anything else.
pub fn parse_utc_stamp_ms(stamp: &str) -> Option<u64> {
    let bytes = stamp.as_bytes();
    if bytes.len() < 20 || !stamp.ends_with('Z') {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        let text = stamp.get(range)?;
        if !text.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        text.parse().ok()
    };
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let millis = match bytes[19] {
        b'.' => {
            let digits = stamp.get(20..stamp.len() - 1)?;
            if digits.is_empty()
                || digits.len() > 9
                || !digits.bytes().all(|byte| byte.is_ascii_digit())
            {
                return None;
            }
            let padded = format!("{digits:0<3}");
            padded[..3].parse::<i64>().ok()?
        }
        b'Z' if bytes.len() == 20 => 0,
        _ => return None,
    };
    let days = days_from_civil(year, month as u32, day as u32);
    let total = ((days * 86_400 + hour * 3600 + minute * 60 + second) * 1000) + millis;
    u64::try_from(total).ok()
}

// ---- reading a window of a log -----------------------------------------------------------------------------------

/// The bytes of a log the upload sends, and where they came from.
#[derive(Debug)]
pub struct LogWindow {
    pub bytes: Vec<u8>,
    /// The file's length when it was opened (the game may have written more since).
    pub source_len: u64,
    /// The byte range of the file that was sent.
    pub start: u64,
    pub end: u64,
    /// Bytes of the wanted range that were left out to stay under the size limit (the oldest ones).
    pub dropped: u64,
}

fn open_shared(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE: the game and its servers keep writing, and nothing they
        // hold is ever locked, renamed or truncated by an upload.
        options.share_mode(0x1 | 0x2 | 0x4);
    }
    options.open(path)
}

/// Reads `[start, end)` of a log, at most its newest `max` bytes, cut at line ends. `start` is a recorded line start
/// (`None`: the whole file is wanted, so only the size limit applies); a recorded start beyond the file (the log was
/// replaced) falls back to the newest `max` bytes. `end` is a recorded end (a finished session), else the length when
/// the file was opened. A window that does not begin at a recorded start skips its first, partial line. A `live` log
/// (one a program may be appending to) also ends at its last complete line; a settings or metadata file is read as
/// it is.
pub fn read_window(
    path: &Path,
    start: Option<u64>,
    end: Option<u64>,
    max: u64,
    live: bool,
) -> std::io::Result<LogWindow> {
    let mut file = open_shared(path)?;
    let source_len = file.metadata()?.len();
    let end = end.map_or(source_len, |end| end.min(source_len));
    let (wanted, at_line_start) = match start {
        Some(start) if start <= end => (start, true),
        Some(_) => (end.saturating_sub(max), false),
        None => (0, true),
    };
    let begin = wanted.max(end.saturating_sub(max));
    let mut dropped = begin - wanted;
    let mut bytes = Vec::with_capacity((end - begin) as usize);
    file.seek(SeekFrom::Start(begin))?;
    file.take(end - begin).read_to_end(&mut bytes)?;
    let mut start = begin;
    if (dropped > 0 || !at_line_start) && begin > 0 {
        if let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') {
            bytes.drain(..=newline);
            start += newline as u64 + 1;
            dropped += newline as u64 + 1;
            if !at_line_start {
                dropped = 0;
            }
        }
    }
    if live {
        if let Some(last) = bytes.iter().rposition(|byte| *byte == b'\n') {
            bytes.truncate(last + 1);
        } else if end == source_len {
            // A single line still being written: nothing complete to send yet.
            bytes.clear();
        }
    }
    let end = start + bytes.len() as u64;
    Ok(LogWindow {
        bytes,
        source_len,
        start,
        end,
        dropped,
    })
}

// ---- redaction ---------------------------------------------------------------------------------------------------

/// How many values of each kind were removed from one file.
pub type RedactionCounts = BTreeMap<String, u32>;

const REDACTED: &str = "[REDACTED]";

/// Keys whose value is removed wherever they appear (lower case): the command line's exchange code, API keys and the
/// game's session id.
const SECRET_KEYS: [&str; 5] = [
    "exchange_code",
    "exchangecode",
    "api_key",
    "apikey",
    "gamesessionid",
];
/// Key endings that name a secret: `token`, `EncryptionToken`, `access_token`, `AUTH_PASSWORD`, `hostCapability`,
/// `client_secret`, `ticket`, ... (`tokens` or `ticketing` are not secrets).
const SECRET_KEY_SUFFIXES: [&str; 7] = [
    "token",
    "password",
    "passwd",
    "secret",
    "capability",
    "credential",
    "ticket",
];
/// Keys removed only as URL query values (`?code=`, `&signature=`): elsewhere `code=5` is an exit or error code.
const URL_ONLY_KEYS: [&str; 3] = ["code", "authorization", "signature"];

fn is_secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    SECRET_KEYS.contains(&key.as_str())
        || SECRET_KEY_SUFFIXES
            .iter()
            .any(|suffix| key.ends_with(suffix))
}

fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn ends_value(byte: u8) -> bool {
    byte.is_ascii_whitespace() || b"&?#;,\"'()[]{}<>|".contains(&byte)
}

fn count(counts: &mut RedactionCounts, kind: &str) {
    *counts.entry(kind.to_string()).or_insert(0) += 1;
}

/// The path segment after `/sessions/kill/`: the game's sign-out sends its access token there.
fn redact_kill_path(text: &str, counts: &mut RedactionCounts) -> String {
    const NEEDLE: &str = "/sessions/kill/";
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut from = 0;
    while let Some(found) = lower[from..].find(NEEDLE) {
        let value_start = from + found + NEEDLE.len();
        let value_end = text.as_bytes()[value_start..]
            .iter()
            .position(|byte| *byte == b'/' || ends_value(*byte))
            .map_or(text.len(), |offset| value_start + offset);
        if value_end > value_start && &text[value_start..value_end] != REDACTED {
            out.push_str(&text[copied..value_start]);
            out.push_str(REDACTED);
            copied = value_end;
            count(counts, "sessionKillPath");
        }
        from = value_end.max(value_start);
    }
    out.push_str(&text[copied..]);
    out
}

fn is_base64url(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
}

/// JWT-shaped values: three base64url parts, the first starting `eyJ`.
fn redact_jwts(text: &str, counts: &mut RedactionCounts) -> String {
    let bytes = text.as_bytes();
    let run = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|byte| is_base64url(**byte))
            .count()
    };
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut index = 0;
    while let Some(found) = text[index..].find("eyJ") {
        let start = index + found;
        let first = run(start + 3);
        let dot1 = start + 3 + first;
        let mut matched = None;
        if first >= 5 && bytes.get(dot1) == Some(&b'.') {
            let second = run(dot1 + 1);
            let dot2 = dot1 + 1 + second;
            if second >= 5 && bytes.get(dot2) == Some(&b'.') {
                matched = Some(dot2 + 1 + run(dot2 + 1));
            }
        }
        match matched {
            Some(end) => {
                out.push_str(&text[copied..start]);
                out.push_str("[REDACTED-JWT]");
                copied = end;
                index = end;
                count(counts, "jwt");
            }
            None => index = start + 3,
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// `Bearer <credential>` (16 characters or more, so ordinary words after "bearer" stay).
fn redact_bearer(text: &str, counts: &mut RedactionCounts) -> String {
    let lower = text.to_ascii_lowercase();
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut from = 0;
    while let Some(found) = lower[from..].find("bearer") {
        let after = from + found + "bearer".len();
        let spaces = bytes[after..]
            .iter()
            .take_while(|byte| **byte == b' ' || **byte == b'\t')
            .count();
        let value_start = after + spaces;
        let value_len = bytes[value_start..]
            .iter()
            .take_while(|byte| byte.is_ascii_alphanumeric() || b"._~+/=-".contains(byte))
            .count();
        if spaces > 0 && value_len >= 16 {
            out.push_str(&text[copied..value_start]);
            out.push_str(REDACTED);
            copied = value_start + value_len;
            count(counts, "bearer");
            from = copied;
        } else {
            from = after;
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// `key=value` for the secret keys: URL options (`?EncryptionToken=`), command-line switches (`-AUTH_PASSWORD=`) and
/// `name=value` diagnostics. The key is the whole word before `=`.
fn redact_key_values(text: &str, counts: &mut RedactionCounts) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'=' {
            index += 1;
            continue;
        }
        let key_start = bytes[..index]
            .iter()
            .rposition(|byte| !is_word(*byte))
            .map_or(0, |position| position + 1);
        let key = &text[key_start..index];
        let prefix = key_start.checked_sub(1).map(|position| bytes[position]);
        let lower = key.to_ascii_lowercase();
        let secret = !key.is_empty()
            && if URL_ONLY_KEYS.contains(&lower.as_str()) {
                matches!(prefix, Some(b'?') | Some(b'&'))
            } else {
                is_secret_key(key)
            };
        if !secret {
            index += 1;
            continue;
        }
        let value_start = index + 1;
        let value_end = bytes[value_start..]
            .iter()
            .position(|byte| ends_value(*byte))
            .map_or(bytes.len(), |offset| value_start + offset);
        if value_end > value_start && &text[value_start..value_end] != REDACTED {
            out.push_str(&text[copied..value_start]);
            out.push_str(REDACTED);
            copied = value_end;
            count(counts, "keyValue");
            index = value_end;
        } else {
            index += 1;
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// `"key": "value"` in JSON text for the secret keys.
fn redact_json_values(text: &str, counts: &mut RedactionCounts) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut index = 0;
    while let Some(found) = text[index..].find('"') {
        let key_start = index + found + 1;
        let key_len = bytes[key_start..]
            .iter()
            .take_while(|byte| is_word(**byte))
            .count();
        let key_end = key_start + key_len;
        index = key_start;
        if key_len == 0 || bytes.get(key_end) != Some(&b'"') {
            continue;
        }
        let mut cursor = key_end + 1;
        while bytes.get(cursor).is_some_and(|byte| *byte == b' ') {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&b':') {
            index = key_end + 1;
            continue;
        }
        cursor += 1;
        while bytes.get(cursor).is_some_and(|byte| *byte == b' ') {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&b'"') {
            index = key_end + 1;
            continue;
        }
        let value_start = cursor + 1;
        let mut value_end = value_start;
        while value_end < bytes.len() && bytes[value_end] != b'"' {
            value_end += if bytes[value_end] == b'\\' { 2 } else { 1 };
        }
        let value_end = value_end.min(bytes.len());
        let key = &text[key_start..key_end];
        if is_secret_key(key)
            && value_end > value_start
            && &text[value_start..value_end] != REDACTED
        {
            out.push_str(&text[copied..value_start]);
            out.push_str(REDACTED);
            copied = value_end;
            count(counts, "json");
        }
        index = value_end.max(key_end + 1).min(bytes.len());
    }
    out.push_str(&text[copied..]);
    out
}

/// Credential-like values removed from any text the upload sends.
pub fn redact_text(text: &str, counts: &mut RedactionCounts) -> String {
    let text = redact_kill_path(text, counts);
    let text = redact_jwts(&text, counts);
    let text = redact_bearer(&text, counts);
    let text = redact_key_values(&text, counts);
    redact_json_values(&text, counts)
}

/// Words that make an ini key's value secret. `auth` alone only when the key does not name an address, so the service
/// addresses a settings file may redirect stay visible.
const INI_SECRET_WORDS: [&str; 9] = [
    "password",
    "passwd",
    "secret",
    "token",
    "apikey",
    "api_key",
    "cookie",
    "ticket",
    "credential",
];
const INI_ADDRESS_WORDS: [&str; 7] = [
    "url", "uri", "endpoint", "host", "domain", "server", "address",
];

fn is_secret_ini_key(key: &str) -> bool {
    let key = key
        .trim()
        .trim_start_matches(['+', '-', '.', '!'])
        .to_ascii_lowercase();
    INI_SECRET_WORDS.iter().any(|word| key.contains(word))
        || (key.contains("auth") && !INI_ADDRESS_WORDS.iter().any(|word| key.contains(word)))
}

/// An ini file: the value of every key that names a secret, then the text rules.
pub fn redact_ini(text: &str, counts: &mut RedactionCounts) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let body = line.trim_end_matches(['\r', '\n']);
        let ending = &line[body.len()..];
        let trimmed = body.trim_start();
        let is_entry = !trimmed.starts_with([';', '#', '[']);
        match body.find('=') {
            Some(equals)
                if is_entry
                    && is_secret_ini_key(&body[..equals])
                    && !body[equals + 1..].trim().is_empty() =>
            {
                out.push_str(&body[..=equals]);
                out.push_str(REDACTED);
                out.push_str(ending);
                count(counts, "ini");
            }
            _ => out.push_str(line),
        }
    }
    redact_text(&out, counts)
}

// ---- offset records ----------------------------------------------------------------------------------------------

/// One recorded log range: `start` is where the log ended when the launcher started the program that writes it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogSpan {
    pub path: String,
    pub start: u64,
    #[serde(default)]
    pub end: Option<u64>,
}

/// A Play session's records, in its session folder (`log-offsets.json`; never uploaded).
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLogOffsets {
    #[serde(default)]
    pub client_log: Option<LogSpan>,
    #[serde(default)]
    pub realm_host_log: Option<LogSpan>,
}

/// One hosted server start (`%LOCALAPPDATA%\MysticParadox\Logs\host-log-offsets.json`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostLogStart {
    pub path: String,
    pub start: u64,
    pub recorded_at_ms: u64,
    #[serde(default)]
    pub account_id: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct HostLogStarts {
    #[serde(default)]
    entries: Vec<HostLogStart>,
}

static OFFSET_FILES: Mutex<()> = Mutex::new(());

fn file_len(path: &Path) -> u64 {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

/// Writes through a temporary file and a rename, so a reader never sees half a record.
fn write_json<T: Serialize>(path: &Path, value: &T) {
    let Ok(text) = serde_json::to_vec_pretty(value) else {
        return;
    };
    let temporary = path.with_extension("json.tmp");
    if fs::write(&temporary, text).is_ok() && fs::rename(&temporary, path).is_err() {
        let _ = fs::remove_file(&temporary);
    }
}

pub fn read_session_offsets(session_dir: &Path) -> SessionLogOffsets {
    fs::read(session_dir.join(SESSION_OFFSETS_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// At Play, before the game starts: where the client's runtime log and the realm host log end now.
pub fn record_session_starts(session_dir: &Path, client_log: &Path, realm_host_log: Option<&Path>) {
    let _guard = OFFSET_FILES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let span = |path: &Path| LogSpan {
        path: path.to_string_lossy().into_owned(),
        start: file_len(path),
        end: None,
    };
    let offsets = SessionLogOffsets {
        client_log: Some(span(client_log)),
        realm_host_log: realm_host_log.map(span),
    };
    write_json(&session_dir.join(SESSION_OFFSETS_FILE), &offsets);
}

/// When the game exits: where the client's runtime log ends, so a later upload sends this session only.
pub fn record_session_end(session_dir: &Path) {
    let _guard = OFFSET_FILES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut offsets = read_session_offsets(session_dir);
    let Some(client) = offsets.client_log.as_mut() else {
        return;
    };
    client.end = Some(file_len(Path::new(&client.path)));
    write_json(&session_dir.join(SESSION_OFFSETS_FILE), &offsets);
}

pub fn read_host_starts(logs_dir: &Path) -> Vec<HostLogStart> {
    fs::read(logs_dir.join(HOST_OFFSETS_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<HostLogStarts>(&bytes).ok())
        .map(|starts| starts.entries)
        .unwrap_or_default()
}

/// Before a hosted server starts: where its runtime log ends now, and which account hosts it.
pub fn record_host_start(logs_dir: &Path, server_log: &Path, account_id: Option<&str>, now: u64) {
    let _guard = OFFSET_FILES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if fs::create_dir_all(logs_dir).is_err() {
        return;
    }
    let mut entries = read_host_starts(logs_dir);
    entries.retain(|entry| now.saturating_sub(entry.recorded_at_ms) <= HOST_RECORD_KEEP_MS);
    entries.push(HostLogStart {
        path: server_log.to_string_lossy().into_owned(),
        start: file_len(server_log),
        recorded_at_ms: now,
        account_id: account_id.map(str::to_string),
    });
    entries.sort_by_key(|entry| entry.recorded_at_ms);
    let excess = entries.len().saturating_sub(HOST_RECORD_MAX);
    entries.drain(..excess);
    write_json(
        &logs_dir.join(HOST_OFFSETS_FILE),
        &HostLogStarts { entries },
    );
}

/// How far before an upload's window a server start may lie and still open its log: a hub runs for hours.
const HOST_RUN_LOOKBACK_MS: u64 = 24 * 60 * 60 * 1000;

/// The start record that opens a hosted server's log for an upload covering `since` onwards: the server that was
/// already running then (the last start before `since`, within `HOST_RUN_LOOKBACK_MS`), so a crash and restart during
/// the session are both in the window; otherwise the first start after `since`.
fn host_start_for<'a>(
    starts: &'a [HostLogStart],
    path: &Path,
    since: u64,
) -> Option<&'a HostLogStart> {
    let key = path_key(path);
    let mut matching: Vec<&HostLogStart> = starts
        .iter()
        .filter(|entry| path_key(Path::new(&entry.path)) == key)
        .collect();
    matching.sort_by_key(|entry| entry.recorded_at_ms);
    matching
        .iter()
        .rev()
        .find(|entry| {
            entry.recorded_at_ms <= since && since - entry.recorded_at_ms <= HOST_RUN_LOOKBACK_MS
        })
        .or_else(|| matching.iter().find(|entry| entry.recorded_at_ms > since))
        .copied()
}

// ---- choosing the files ------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    Session,
    Launcher,
    Config,
    GameClient,
    HostedServer,
    RealmHost,
    Connection,
    LauncherExit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Redaction {
    Text,
    Ini,
}

#[derive(Debug)]
pub enum Body {
    File {
        path: PathBuf,
        start: Option<u64>,
        end: Option<u64>,
        max: u64,
        /// Appended to while the game or the launcher runs (`read_window`).
        live: bool,
    },
    Bytes(Vec<u8>),
}

#[derive(Debug)]
pub struct Source {
    /// The name on the server (`services/launcherLogNames.ts` allows exactly these).
    pub name: String,
    pub kind: SourceKind,
    pub body: Body,
    pub redaction: Redaction,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub name: String,
    pub reason: String,
}

/// The Play session an upload belongs to.
#[derive(Debug)]
pub struct PlaySession {
    pub dir: PathBuf,
    pub started_ms: Option<u64>,
    pub game_dir: Option<PathBuf>,
    pub offsets: SessionLogOffsets,
}

pub struct PlanInputs<'a> {
    /// `None`: the account has no Play session on this PC; the upload carries its host logs only.
    pub session: Option<&'a PlaySession>,
    /// The game folders whose runtime logs may be sent (the session's, and the one hosted servers run from).
    pub game_dirs: Vec<PathBuf>,
    /// `%LOCALAPPDATA%\MysticParadox\Logs`.
    pub logs_dir: PathBuf,
    /// Connection logs written while no Play session ran.
    pub idle_connection_dir: Option<PathBuf>,
    pub config_dir: Option<PathBuf>,
    pub host_starts: Vec<HostLogStart>,
    pub account_id: &'a str,
    pub now_ms: u64,
    /// The `metadata.json` of an upload without a Play session.
    pub host_only_metadata: Vec<u8>,
}

pub struct UploadPlan {
    /// Files written before this were not part of the upload.
    pub since_ms: u64,
    pub sources: Vec<Source>,
    pub skipped: Vec<Skipped>,
}

/// The port of a `mysticparadox_dll_port<N>.log` name.
pub fn runtime_log_port(name: &str) -> Option<u32> {
    let digits = name
        .strip_prefix("mysticparadox_dll_port")?
        .strip_suffix(".log")?;
    if digits.is_empty() || digits.len() > 6 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// `p2p-<file>` for a connection log, when the name stays inside the server's rule (`^p2p-[A-Za-z0-9._-]{1,120}\.log$`).
pub fn connection_upload_name(file_name: &str) -> Option<String> {
    let stem = file_name.strip_suffix(".log")?;
    let valid = !stem.is_empty()
        && stem.len() <= 120
        && !stem.contains("..")
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte));
    valid.then(|| format!("p2p-{stem}.log"))
}

fn written_since(path: &Path, since: u64) -> bool {
    modified_ms(path).is_some_and(|modified| modified >= since)
}

/// A log some program may still be appending to.
fn file_source(
    name: impl Into<String>,
    kind: SourceKind,
    path: PathBuf,
    start: Option<u64>,
    end: Option<u64>,
    max: u64,
) -> Source {
    Source {
        name: name.into(),
        kind,
        body: Body::File {
            path,
            start,
            end,
            max,
            live: true,
        },
        redaction: Redaction::Text,
    }
}

/// A small file read as it is (metadata, settings).
fn whole_file(
    name: &str,
    kind: SourceKind,
    path: PathBuf,
    max: u64,
    redaction: Redaction,
) -> Source {
    Source {
        name: name.to_string(),
        kind,
        body: Body::File {
            path,
            start: None,
            end: None,
            max,
            live: false,
        },
        redaction,
    }
}

/// The files of one upload, in the order they are sent (the most useful first, the manifest last, outside this list).
pub fn plan_upload(inputs: &PlanInputs) -> UploadPlan {
    let since = inputs
        .session
        .and_then(|session| session.started_ms)
        .unwrap_or_else(|| inputs.now_ms.saturating_sub(HOST_ONLY_WINDOW_MS));
    let mut sources = Vec::new();
    let mut skipped = Vec::new();

    match inputs.session {
        Some(session) => {
            let metadata = session.dir.join("metadata.json");
            if metadata.is_file() {
                sources.push(whole_file(
                    "metadata.json",
                    SourceKind::Session,
                    metadata,
                    METADATA_MAX,
                    Redaction::Text,
                ));
            }
            let launcher = session.dir.join("launcher.log");
            if launcher.is_file() {
                sources.push(file_source(
                    "launcher.log",
                    SourceKind::Launcher,
                    launcher,
                    None,
                    None,
                    LAUNCHER_LOG_MAX,
                ));
            }
        }
        None => sources.push(Source {
            name: "metadata.json".to_string(),
            kind: SourceKind::Session,
            body: Body::Bytes(inputs.host_only_metadata.clone()),
            redaction: Redaction::Text,
        }),
    }

    if let Some(config_dir) = &inputs.config_dir {
        for (file, name) in CONFIG_FILES {
            let path = config_dir.join(file);
            if path.is_file() {
                sources.push(whole_file(
                    name,
                    SourceKind::Config,
                    path,
                    CONFIG_MAX,
                    Redaction::Ini,
                ));
            }
        }
    }

    // The game client of the session: from where its log stood at Play to where it stood at exit.
    let client_name = format!("runtime-{CLIENT_LOG_NAME}");
    if let Some(session) = inputs.session {
        if let Some(game_dir) = &session.game_dir {
            let path = game_dir.join(CLIENT_LOG_NAME);
            let recorded = session
                .offsets
                .client_log
                .as_ref()
                .filter(|span| path_key(Path::new(&span.path)) == path_key(&path));
            if !path.is_file() {
                // No client log: the game never started far enough to write one.
            } else if let Some(span) = recorded {
                sources.push(file_source(
                    &client_name,
                    SourceKind::GameClient,
                    path,
                    Some(span.start),
                    span.end,
                    RUNTIME_LOG_MAX,
                ));
            } else if written_since(&path, since) {
                sources.push(file_source(
                    &client_name,
                    SourceKind::GameClient,
                    path,
                    None,
                    None,
                    RUNTIME_LOG_MAX,
                ));
            } else {
                skipped.push(Skipped {
                    name: client_name.clone(),
                    reason: "not written during this session".to_string(),
                });
            }
        }
    }

    let realm_host = inputs.logs_dir.join(REALM_HOST_LOG);
    if realm_host.is_file() && written_since(&realm_host, since) {
        let start = inputs
            .session
            .and_then(|session| session.offsets.realm_host_log.as_ref())
            .filter(|span| path_key(Path::new(&span.path)) == path_key(&realm_host))
            .map(|span| span.start);
        sources.push(file_source(
            REALM_HOST_LOG,
            SourceKind::RealmHost,
            realm_host,
            start,
            None,
            REALM_HOST_LOG_MAX,
        ));
    }

    // Hosted servers: only the newest logs written since the session started, and only those this account hosted.
    let mut servers: Vec<(u64, PathBuf, Option<u64>)> = Vec::new();
    let mut seen_dirs: Vec<String> = Vec::new();
    for game_dir in &inputs.game_dirs {
        let key = path_key(game_dir);
        if seen_dirs.contains(&key) {
            continue;
        }
        seen_dirs.push(key);
        let Ok(entries) = fs::read_dir(game_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let Some(port) = runtime_log_port(&file_name) else {
                continue;
            };
            if port == 0 {
                continue;
            }
            let path = entry.path();
            let Some(modified) = modified_ms(&path).filter(|modified| *modified >= since) else {
                continue;
            };
            let record = host_start_for(&inputs.host_starts, &path, since);
            if record
                .and_then(|record| record.account_id.as_deref())
                .is_some_and(|owner| owner != inputs.account_id)
            {
                skipped.push(Skipped {
                    name: format!("runtime-{file_name}"),
                    reason: "hosted by another account on this PC".to_string(),
                });
                continue;
            }
            servers.push((modified, path, record.map(|record| record.start)));
        }
    }
    servers.sort_by_key(|server| std::cmp::Reverse(server.0));
    for (index, (_, path, start)) in servers.into_iter().enumerate() {
        let name = format!(
            "runtime-{}",
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        );
        if index >= MAX_HOSTED_SERVER_LOGS {
            skipped.push(Skipped {
                name,
                reason: format!("only the newest {MAX_HOSTED_SERVER_LOGS} server logs are sent"),
            });
            continue;
        }
        sources.push(file_source(
            name,
            SourceKind::HostedServer,
            path,
            start,
            None,
            RUNTIME_LOG_MAX,
        ));
    }

    // Connection logs (transport, host and join): the newest, from the session folder and from hosting without one.
    let mut connections: Vec<(u64, String, PathBuf)> = Vec::new();
    let connection_dirs = inputs
        .session
        .map(|session| session.dir.join("p2p-logs"))
        .into_iter()
        .chain(inputs.idle_connection_dir.clone());
    for dir in connection_dirs {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(modified) = modified_ms(&path).filter(|modified| *modified >= since) else {
                continue;
            };
            let file_name = entry.file_name().to_string_lossy().into_owned();
            match connection_upload_name(&file_name) {
                Some(name) if !connections.iter().any(|(_, existing, _)| *existing == name) => {
                    connections.push((modified, name, path))
                }
                Some(_) => {}
                None if file_name.ends_with(".log") => skipped.push(Skipped {
                    name: file_name,
                    reason: "its name is not one the server accepts".to_string(),
                }),
                None => {}
            }
        }
    }
    connections.sort_by_key(|connection| std::cmp::Reverse(connection.0));
    for (index, (_, name, path)) in connections.into_iter().enumerate() {
        if index >= MAX_CONNECTION_LOGS {
            skipped.push(Skipped {
                name,
                reason: format!("only the newest {MAX_CONNECTION_LOGS} connection logs are sent"),
            });
            continue;
        }
        sources.push(file_source(
            name,
            SourceKind::Connection,
            path,
            None,
            None,
            CONNECTION_LOG_MAX,
        ));
    }

    let exit_log = inputs.logs_dir.join(LAUNCHER_EXIT_LOG);
    if exit_log.is_file() && written_since(&exit_log, since) {
        sources.push(file_source(
            LAUNCHER_EXIT_LOG,
            SourceKind::LauncherExit,
            exit_log,
            None,
            None,
            EXIT_LOG_MAX,
        ));
    }

    UploadPlan {
        since_ms: since,
        sources,
        skipped,
    }
}

/// A source's bytes as they are sent: its window, a note naming what was left out, and credential-like values removed.
pub struct Prepared {
    pub bytes: Vec<u8>,
    pub window: Option<LogWindow>,
    pub redactions: RedactionCounts,
}

pub fn prepare(source: &Source) -> std::io::Result<Prepared> {
    let (raw, window) = match &source.body {
        Body::Bytes(bytes) => (bytes.clone(), None),
        Body::File {
            path,
            start,
            end,
            max,
            live,
        } => {
            let mut window = read_window(path, *start, *end, *max, *live)?;
            let bytes = std::mem::take(&mut window.bytes);
            (bytes, Some(window))
        }
    };
    let mut redactions = RedactionCounts::new();
    let text = String::from_utf8_lossy(&raw);
    let mut cleaned = match source.redaction {
        Redaction::Text => redact_text(&text, &mut redactions),
        Redaction::Ini => redact_ini(&text, &mut redactions),
    };
    if let Some(window) = window.as_ref().filter(|window| window.dropped > 0) {
        cleaned.insert_str(
            0,
            &format!(
                "[upload] bytes {}-{} of this file are not included (size limit); the newest lines follow.\n",
                window.start - window.dropped,
                window.start
            ),
        );
    }
    Ok(Prepared {
        bytes: cleaned.into_bytes(),
        window,
        redactions,
    })
}

// ---- the manifest ------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    pub name: String,
    pub kind: SourceKind,
    /// uploaded, failed or skipped.
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range_start: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range_end: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dropped_bytes: Option<u64>,
    pub sent_bytes: u64,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub redactions: RedactionCounts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema: u32,
    pub upload_id: String,
    /// `play` (a Play session and the logs written since it started) or `host` (no Play session: the host's logs).
    pub upload_kind: &'static str,
    pub created_at: String,
    pub since: String,
    pub launcher_version: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_sha256: Option<String>,
    pub game_running: bool,
    pub files: Vec<ManifestFile>,
    pub skipped: Vec<Skipped>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mysticparadox-log-upload-{label}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn redacted(text: &str) -> (String, RedactionCounts) {
        let mut counts = RedactionCounts::new();
        (redact_text(text, &mut counts), counts)
    }

    #[test]
    fn utc_stamps_parse_to_milliseconds() {
        assert_eq!(parse_utc_stamp_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_utc_stamp_ms("2023-11-14T22:13:20.123Z"),
            Some(1_700_000_000_123)
        );
        assert_eq!(
            parse_utc_stamp_ms("2023-11-14T22:13:20Z"),
            Some(1_700_000_000_000)
        );
        assert_eq!(parse_utc_stamp_ms("2023-11-14 22:13:20Z"), None);
        assert_eq!(parse_utc_stamp_ms("not a time"), None);
        assert_eq!(
            parse_utc_stamp_ms(&crate::launch::logs::iso8601_now()).map(|ms| ms / 1000),
            Some(now_ms() / 1000)
        );
    }

    #[test]
    fn a_recorded_window_is_sent_whole_and_cut_at_its_last_complete_line() {
        let dir = temp_dir("window");
        let path = dir.join("log.log");
        fs::write(&path, "old 1\nold 2\nnew 1\nnew 2\npartial").unwrap();
        let window = read_window(&path, Some(12), None, 1024, true).unwrap();
        assert_eq!(String::from_utf8(window.bytes).unwrap(), "new 1\nnew 2\n");
        assert_eq!((window.start, window.end, window.dropped), (12, 24, 0));
        // A finished session's end bounds the window even though the file grew.
        let window = read_window(&path, Some(6), Some(18), 1024, true).unwrap();
        assert_eq!(String::from_utf8(window.bytes).unwrap(), "old 2\nnew 1\n");
        // A settings or metadata file keeps its last line even without a newline.
        let json = dir.join("metadata.json");
        fs::write(&json, "{\n  \"a\": 1\n}").unwrap();
        let window = read_window(&json, None, None, 1024, false).unwrap();
        assert_eq!(String::from_utf8(window.bytes).unwrap(), "{\n  \"a\": 1\n}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_window_over_the_limit_keeps_the_newest_complete_lines() {
        let dir = temp_dir("limit");
        let path = dir.join("log.log");
        fs::write(&path, "aaaa\nbbbb\ncccc\ndddd\n").unwrap();
        let window = read_window(&path, Some(0), None, 8, true).unwrap();
        // The newest 8 bytes start inside "cccc"; the partial line is skipped.
        assert_eq!(String::from_utf8(window.bytes).unwrap(), "dddd\n");
        assert_eq!((window.start, window.dropped), (15, 15));
        // No record: the newest bytes of the whole file.
        let window = read_window(&path, None, None, 11, true).unwrap();
        assert_eq!(String::from_utf8(window.bytes).unwrap(), "cccc\ndddd\n");
        // A recorded start past the file (the log was replaced) falls back to its newest bytes, with nothing "dropped".
        let window = read_window(&path, Some(500), None, 6, true).unwrap();
        assert_eq!(String::from_utf8(window.bytes).unwrap(), "dddd\n");
        assert_eq!(window.dropped, 0);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_log_another_process_is_writing_can_be_read() {
        let dir = temp_dir("shared");
        let path = dir.join("live.log");
        let mut writer = {
            let mut options = fs::OpenOptions::new();
            options.create(true).append(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.share_mode(0x1 | 0x2 | 0x4);
            }
            options.open(&path).unwrap()
        };
        writer.write_all(b"line 1\nline 2\n").unwrap();
        writer.flush().unwrap();
        let window = read_window(&path, Some(0), None, 1024, true).unwrap();
        assert_eq!(String::from_utf8(window.bytes).unwrap(), "line 1\nline 2\n");
        // The writer keeps writing after the read.
        writer.write_all(b"line 3\n").unwrap();
        drop(writer);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "line 1\nline 2\nline 3\n"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn url_options_and_switches_lose_their_secret_values() {
        let (text, counts) = redacted(
            "[UrlPathDiag] travel 127.0.0.1:7777/Game/Map?EncryptionToken=abc123?Name=Slayer?gameSessionId=xyz\n\
             args -AUTH_LOGIN=acct -AUTH_PASSWORD=f00dbabe -epicapp=Archon\n\
             GET /launcher/v1/x?token=t1&code=c2&mode=play&signature=s3\n",
        );
        assert!(text.contains("?EncryptionToken=[REDACTED]?Name=Slayer?gameSessionId=[REDACTED]"));
        assert!(text.contains("-AUTH_LOGIN=acct -AUTH_PASSWORD=[REDACTED] -epicapp=Archon"));
        assert!(text.contains("?token=[REDACTED]&code=[REDACTED]&mode=play&signature=[REDACTED]"));
        assert_eq!(counts.get("keyValue"), Some(&6));
    }

    #[test]
    fn exit_codes_and_ordinary_words_are_kept() {
        let (text, counts) =
            redacted("exited (code=0) code=5 tokens=4 bearer of news ticketing=on\n");
        assert_eq!(
            text,
            "exited (code=0) code=5 tokens=4 bearer of news ticketing=on\n"
        );
        assert!(counts.is_empty());
    }

    /// A JWT-shaped test value, built here so no token-shaped literal sits in the source.
    fn fake_jwt() -> String {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        let part = |text: &str| URL_SAFE_NO_PAD.encode(text);
        format!(
            "{}.{}.{}",
            part(r#"{"alg":"RS256"}"#),
            part(r#"{"userId":"test-user"}"#),
            part("signature-value-here")
        )
    }

    #[test]
    fn the_sign_out_path_jwts_and_bearer_values_are_removed() {
        let jwt = fake_jwt();
        assert!(jwt.starts_with("eyJ"));
        let bearer = "b".repeat(24);
        let (text, counts) = redacted(&format!(
            "DELETE /__origin/x/account/api/oauth/sessions/kill/KEY-0123456789abcdef?x=1 [rewritten]\n\
             DELETE /account/api/oauth/sessions/kill?killType=OTHERS\n\
             Authorization: Bearer {bearer}\n\
             token {jwt} end\n"
        ));
        assert!(text.contains("/sessions/kill/[REDACTED]?x=1 [rewritten]"));
        assert!(text.contains("/sessions/kill?killType=OTHERS"));
        assert!(text.contains("Bearer [REDACTED]"));
        assert!(text.contains("token [REDACTED-JWT] end"));
        assert!(!text.contains(&jwt));
        assert!(!text.contains(&bearer));
        assert_eq!(counts.get("sessionKillPath"), Some(&1));
        assert_eq!(counts.get("jwt"), Some(&1));
        assert_eq!(counts.get("bearer"), Some(&1));
    }

    #[test]
    fn json_secret_values_are_removed_and_error_codes_kept() {
        let (text, counts) = redacted(
            r#"{"access_token": "abc", "code":"AUTH_TESTER_REQUIRED", "hostCapability":"cap", "displayName":"Slayer"}"#,
        );
        assert_eq!(
            text,
            r#"{"access_token": "[REDACTED]", "code":"AUTH_TESTER_REQUIRED", "hostCapability":"[REDACTED]", "displayName":"Slayer"}"#
        );
        assert_eq!(counts.get("json"), Some(&2));
        let (text, _) = redacted(r#"{"relay_password":"p"}"#);
        assert_eq!(text, r#"{"relay_password":"[REDACTED]"}"#);
    }

    #[test]
    fn ini_secrets_go_and_service_addresses_stay() {
        let mut counts = RedactionCounts::new();
        let text = redact_ini(
            "[/Script/Archon.Settings]\r\nCheckCrossPlayProgressionEndpoint=http://192.0.2.10/x/{platform}\r\n\
             AuthServiceUrl=https://example.test/auth\r\nAuthToken=secret1\r\n+ApiKey=k2\r\n; ApiKey=comment\r\nPlainKey=value",
            &mut counts,
        );
        assert!(
            text.contains("CheckCrossPlayProgressionEndpoint=http://192.0.2.10/x/{platform}\r\n")
        );
        assert!(text.contains("AuthServiceUrl=https://example.test/auth\r\n"));
        assert!(text.contains("AuthToken=[REDACTED]\r\n"));
        assert!(text.contains("+ApiKey=[REDACTED]\r\n"));
        // A comment is not a setting; the text rules still apply to it.
        assert!(text.contains("; ApiKey=[REDACTED]\r\n"));
        assert!(text.ends_with("PlainKey=value"));
        assert_eq!(counts.get("ini"), Some(&2));
        assert_eq!(counts.get("keyValue"), Some(&1));
    }

    #[test]
    fn names_follow_the_servers_rules() {
        assert_eq!(runtime_log_port("mysticparadox_dll_port0.log"), Some(0));
        assert_eq!(
            runtime_log_port("mysticparadox_dll_port8791.log"),
            Some(8791)
        );
        assert_eq!(runtime_log_port("mysticparadox_dll_port.log"), None);
        assert_eq!(runtime_log_port("mysticparadox_dll_portx.log"), None);
        assert_eq!(
            connection_upload_name("4f6a2d1e-0000-4000-8000-000000000001-3-host-a1b2c3.log")
                .as_deref(),
            Some("p2p-4f6a2d1e-0000-4000-8000-000000000001-3-host-a1b2c3.log")
        );
        assert_eq!(connection_upload_name("bad name.log"), None);
        assert_eq!(connection_upload_name("a..b.log"), None);
        assert_eq!(
            connection_upload_name(&format!("{}.log", "a".repeat(121))),
            None
        );
        assert_eq!(connection_upload_name("notes.txt"), None);
    }

    #[test]
    fn host_starts_pick_the_run_that_covers_the_window_and_drop_old_records() {
        let dir = temp_dir("host-starts");
        let log = dir.join("mysticparadox_dll_port8791.log");
        fs::write(&log, "x\n").unwrap();
        record_host_start(&dir, &log, Some("me"), 1_000);
        fs::write(&log, "x\ny\n").unwrap();
        record_host_start(&dir, &log, Some("me"), 5_000);
        let starts = read_host_starts(&dir);
        assert_eq!(starts.len(), 2);
        // Running when the session started: from that run, so its crash and the restart at 5000 are both sent.
        assert_eq!(
            host_start_for(&starts, &log, 3_000).map(|entry| entry.start),
            Some(2)
        );
        assert_eq!(
            host_start_for(&starts, &log, 6_000).map(|entry| entry.start),
            Some(4)
        );
        // Started after the session began: the first start in the window.
        assert_eq!(
            host_start_for(&starts, &log, 500).map(|entry| entry.start),
            Some(2)
        );
        // A run that started more than a day before the window does not open it.
        assert_eq!(
            host_start_for(&starts, &log, 5_000 + HOST_RUN_LOOKBACK_MS + 1),
            None
        );
        // A week later the old records are gone.
        record_host_start(&dir, &log, None, 1_000 + HOST_RECORD_KEEP_MS + 5_000);
        assert_eq!(read_host_starts(&dir).len(), 1);
        fs::remove_dir_all(&dir).ok();
    }

    fn set_old(path: &Path) {
        let old = SystemTime::now() - std::time::Duration::from_secs(10 * 24 * 3600);
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(old)
            .unwrap();
    }

    #[test]
    fn only_the_newest_logs_of_the_session_are_planned() {
        let root = temp_dir("plan");
        let game = root.join("Win64");
        let logs = root.join("Logs");
        let session_dir = root.join("Sessions").join("s1");
        let config = root.join("Config");
        for dir in [&game, &logs, &session_dir.join("p2p-logs"), &config] {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(session_dir.join("metadata.json"), "{}").unwrap();
        fs::write(session_dir.join("launcher.log"), "l\n").unwrap();
        fs::write(config.join("Game.ini"), "[x]\nA=1\n").unwrap();
        fs::write(game.join(CLIENT_LOG_NAME), "before\nduring\n").unwrap();
        // Six server logs written now, one of another account, one stale from last week.
        for port in [8790, 8791, 8792, 8793, 8794] {
            fs::write(
                game.join(format!("mysticparadox_dll_port{port}.log")),
                "s\n",
            )
            .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        fs::write(game.join("mysticparadox_dll_port8795.log"), "other\n").unwrap();
        fs::write(game.join("mysticparadox_dll_port8780.log"), "stale\n").unwrap();
        set_old(&game.join("mysticparadox_dll_port8780.log"));
        record_host_start(
            &logs,
            &game.join("mysticparadox_dll_port8795.log"),
            Some("someone-else"),
            now_ms(),
        );
        fs::write(
            session_dir.join("p2p-logs").join("abc-1-host-ff.log"),
            "p\n",
        )
        .unwrap();
        fs::write(logs.join(REALM_HOST_LOG), "r\n").unwrap();

        let session = PlaySession {
            dir: session_dir.clone(),
            started_ms: Some(now_ms() - 60_000),
            game_dir: Some(game.clone()),
            offsets: SessionLogOffsets {
                client_log: Some(LogSpan {
                    path: game.join(CLIENT_LOG_NAME).to_string_lossy().into_owned(),
                    start: 7,
                    end: None,
                }),
                realm_host_log: None,
            },
        };
        let plan = plan_upload(&PlanInputs {
            session: Some(&session),
            game_dirs: vec![game.clone(), game.clone()],
            logs_dir: logs.clone(),
            idle_connection_dir: None,
            config_dir: Some(config.clone()),
            host_starts: read_host_starts(&logs),
            account_id: "me",
            now_ms: now_ms(),
            host_only_metadata: Vec::new(),
        });
        let names: Vec<&str> = plan
            .sources
            .iter()
            .map(|source| source.name.as_str())
            .collect();
        assert_eq!(
            names,
            vec![
                "metadata.json",
                "launcher.log",
                "config-Game.ini",
                "runtime-mysticparadox_dll_port0.log",
                "realm-host.log",
                "runtime-mysticparadox_dll_port8794.log",
                "runtime-mysticparadox_dll_port8793.log",
                "runtime-mysticparadox_dll_port8792.log",
                "runtime-mysticparadox_dll_port8791.log",
                "p2p-abc-1-host-ff.log",
            ]
        );
        assert!(plan.skipped.contains(&Skipped {
            name: "runtime-mysticparadox_dll_port8795.log".to_string(),
            reason: "hosted by another account on this PC".to_string()
        }));
        assert!(plan
            .skipped
            .iter()
            .any(|skip| skip.name == "runtime-mysticparadox_dll_port8790.log"));
        assert!(
            !plan.skipped.iter().any(|skip| skip.name.contains("8780")),
            "a stale log is not even listed"
        );
        // The client log is sent from where it stood at Play.
        let client = plan
            .sources
            .iter()
            .find(|source| source.kind == SourceKind::GameClient)
            .unwrap();
        assert_eq!(
            String::from_utf8(prepare(client).unwrap().bytes).unwrap(),
            "during\n"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn without_a_play_session_the_hosts_logs_are_planned_with_their_own_metadata() {
        let root = temp_dir("host-only");
        let game = root.join("Win64");
        let logs = root.join("Logs");
        let idle = root.join("p2p-logs");
        for dir in [&game, &logs, &idle] {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(game.join(CLIENT_LOG_NAME), "client\n").unwrap();
        fs::write(
            game.join("mysticparadox_dll_port8791.log"),
            "old run\nhub\n",
        )
        .unwrap();
        record_host_start(
            &logs,
            &game.join("mysticparadox_dll_port8791.log"),
            Some("me"),
            now_ms() - 1_000,
        );
        fs::write(
            game.join("mysticparadox_dll_port8791.log"),
            "old run\nhub\nnew\n",
        )
        .unwrap();
        fs::write(idle.join("hub-1-host-aa.log"), "c\n").unwrap();
        let plan = plan_upload(&PlanInputs {
            session: None,
            game_dirs: vec![game.clone()],
            logs_dir: logs.clone(),
            idle_connection_dir: Some(idle.clone()),
            config_dir: None,
            host_starts: read_host_starts(&logs),
            account_id: "me",
            now_ms: now_ms(),
            host_only_metadata: b"{\"uploadKind\":\"host\"}".to_vec(),
        });
        let names: Vec<&str> = plan
            .sources
            .iter()
            .map(|source| source.name.as_str())
            .collect();
        // No game client without a Play session.
        assert_eq!(
            names,
            vec![
                "metadata.json",
                "runtime-mysticparadox_dll_port8791.log",
                "p2p-hub-1-host-aa.log"
            ]
        );
        assert!(
            matches!(&plan.sources[0].body, Body::Bytes(bytes) if bytes.starts_with(b"{\"uploadKind\""))
        );
        // From the recorded start of the hub's run, not the earlier runs of the same port.
        let hub = &plan.sources[1];
        assert_eq!(
            String::from_utf8(prepare(hub).unwrap().bytes).unwrap(),
            "new\n"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_cut_file_says_what_was_left_out() {
        let dir = temp_dir("marker");
        let path = dir.join("log.log");
        fs::write(&path, "aaaa\nbbbb\ncccc\n").unwrap();
        let prepared = prepare(&file_source(
            "x.log",
            SourceKind::Launcher,
            path,
            None,
            None,
            6,
        ))
        .unwrap();
        assert_eq!(
            String::from_utf8(prepared.bytes).unwrap(),
            "[upload] bytes 0-10 of this file are not included (size limit); the newest lines follow.\ncccc\n"
        );
        fs::remove_dir_all(&dir).ok();
    }
}
