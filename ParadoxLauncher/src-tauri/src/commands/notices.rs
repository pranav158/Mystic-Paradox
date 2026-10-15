//! [2026-10-15] Launcher notices: the sticky announcement banner and the tags the operator sets in the manager.
//!
//! `GET /launcher/v1/notices` on the OFFICIAL backend (accounts and realms use it). No sign-in, no token, a short
//! timeout, and a defensive parse: an item that does not fit the contract is dropped, never shown in part. A backend
//! without the route (an older build answers 404) means "no notices", silently. Any other non-200 answer (a 5xx while the
//! backend restarts, a 429) and a failure to reach the backend are an `Err`, so the screens keep the last good answer
//! instead of dropping a live banner.

use serde::Serialize;
use serde_json::Value;
use std::io::Read;
use std::time::Duration;

use crate::commands::auth::{api_base_url, http_client, run_auth_task};

/// Announcements the launcher shows at most (the first valid ones, in the order the backend sent them).
pub(crate) const MAX_ANNOUNCEMENTS: usize = 3;
/// Tags the launcher shows at most (the first valid ones).
pub(crate) const MAX_TAGS: usize = 4;
const MAX_ANNOUNCEMENT_CHARS: usize = 280;
const MAX_TAG_CHARS: usize = 24;
const MAX_ID_CHARS: usize = 64;
const MAX_EVENT_AT_CHARS: usize = 40;
/// The answer is read up to this size. A bigger body is cut and does not parse, so it means no notices.
const MAX_BODY_BYTES: u64 = 64 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AnnouncementTone {
    Info,
    Warning,
    Critical,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TagTone {
    Info,
    Warning,
    Danger,
    Success,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAnnouncement {
    pub id: String,
    pub text: String,
    pub tone: AnnouncementTone,
    /// The moment `{time}` shows, as the backend sent it. Absent or unreadable: the token is left out of the text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTag {
    pub id: String,
    pub text: String,
    pub tone: TagTone,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeNotices {
    pub announcements: Vec<NativeAnnouncement>,
    pub tags: Vec<NativeTag>,
}

/// One line of plain text: control characters become spaces and runs of spaces collapse. Empty, or longer than `max`
/// characters after that, is refused.
fn one_line(value: &Value, max: usize) -> Option<String> {
    let line = value
        .as_str()?
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!line.is_empty() && line.chars().count() <= max).then_some(line)
}

/// The item's `id` when it is a short, non-empty string; otherwise a stand-in from its position in the list.
fn item_id(item: &Value, index: usize) -> String {
    item.get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.chars().count() <= MAX_ID_CHARS)
        .map(str::to_string)
        .unwrap_or_else(|| format!("notice-{index}"))
}

/// The `eventAt` of an announcement when it is a short string. Anything else is no time at all (the item stays).
fn event_at(item: &Value) -> Option<String> {
    item.get("eventAt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|at| !at.is_empty() && at.chars().count() <= MAX_EVENT_AT_CHARS)
        .map(str::to_string)
}

fn parse_announcement(item: &Value, index: usize) -> Option<NativeAnnouncement> {
    let tone = match item.get("tone")?.as_str()? {
        "info" => AnnouncementTone::Info,
        "warning" => AnnouncementTone::Warning,
        "critical" => AnnouncementTone::Critical,
        _ => return None,
    };
    Some(NativeAnnouncement {
        id: item_id(item, index),
        text: one_line(item.get("text")?, MAX_ANNOUNCEMENT_CHARS)?,
        tone,
        event_at: event_at(item),
    })
}

fn parse_tag(item: &Value, index: usize) -> Option<NativeTag> {
    let tone = match item.get("tone")?.as_str()? {
        "info" => TagTone::Info,
        "warning" => TagTone::Warning,
        "danger" => TagTone::Danger,
        "success" => TagTone::Success,
        _ => return None,
    };
    Some(NativeTag {
        id: item_id(item, index),
        text: one_line(item.get("text")?, MAX_TAG_CHARS)?,
        tone,
    })
}

/// The first `limit` items that parse, in order. An id already kept is dropped (the second copy), so the screen never
/// shows two of the same item.
fn collect<T>(
    items: &[Value],
    limit: usize,
    parse: impl Fn(&Value, usize) -> Option<T>,
    id: impl Fn(&T) -> &str,
) -> Vec<T> {
    let mut kept: Vec<T> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        if kept.len() == limit {
            break;
        }
        let Some(parsed) = parse(item, index) else {
            continue;
        };
        if kept.iter().any(|other| id(other) == id(&parsed)) {
            continue;
        }
        kept.push(parsed);
    }
    kept
}

/// The notices in a response body. Anything that is not the contract's shape (not JSON, not an object) is no notices.
pub(crate) fn parse_notices(body: &[u8]) -> NativeNotices {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return NativeNotices::default();
    };
    let announcements = value
        .get("announcements")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let tags = value
        .get("tags")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    NativeNotices {
        announcements: collect(
            announcements,
            MAX_ANNOUNCEMENTS,
            parse_announcement,
            |announcement| announcement.id.as_str(),
        ),
        tags: collect(tags, MAX_TAGS, parse_tag, |tag| tag.id.as_str()),
    }
}

/// `GET {base}/launcher/v1/notices`. A 404 (an older backend) is an `Ok` with no notices; any other non-200 answer and a
/// backend that cannot be reached are an `Err`, so the caller keeps its last good answer.
pub(crate) fn fetch_notices(base: &str) -> Result<NativeNotices, String> {
    let response = http_client()?
        .get(format!("{base}/launcher/v1/notices"))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .map_err(|_| "Can't reach the Mystic Paradox service right now.".to_string())?;
    if response.status().as_u16() == 404 {
        return Ok(NativeNotices::default());
    }
    if !response.status().is_success() {
        return Err(format!(
            "The notices answered {}.",
            response.status().as_u16()
        ));
    }
    let mut body = Vec::new();
    response
        .take(MAX_BODY_BYTES)
        .read_to_end(&mut body)
        .map_err(|_| "Can't reach the Mystic Paradox service right now.".to_string())?;
    Ok(parse_notices(&body))
}

/// The launcher's notices from the official backend. Needs no sign-in, so it works on the sign-in screens too.
#[tauri::command]
pub async fn native_launcher_notices() -> Result<NativeNotices, String> {
    run_auth_task(|| fetch_notices(api_base_url())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::{error_json, mock_backend};
    use serde_json::json;
    use std::net::TcpListener;

    fn parsed(value: Value) -> NativeNotices {
        parse_notices(value.to_string().as_bytes())
    }

    fn announcement(id: &str, text: &str, tone: &str) -> Value {
        json!({ "id": id, "text": text, "tone": tone })
    }

    fn tag(id: &str, text: &str, tone: &str) -> Value {
        json!({ "id": id, "text": text, "tone": tone })
    }

    #[test]
    fn the_notices_route_is_public_and_carries_no_token() {
        let (base, requests) = mock_backend(vec![(
            200,
            r#"{"announcements":[],"tags":[],"serverTime":"2026-10-15T12:00:00.000Z"}"#.to_string(),
        )]);
        assert_eq!(fetch_notices(&base).unwrap(), NativeNotices::default());
        let request = requests.recv().unwrap();
        assert_eq!(request.method, "get");
        assert_eq!(request.path, "/launcher/v1/notices");
        assert!(
            !request.text.contains("authorization"),
            "the notices call carries no token"
        );
    }

    #[test]
    fn a_404_from_an_older_backend_means_no_notices() {
        let (base, _requests) = mock_backend(vec![(404, error_json("NOT_FOUND"))]);
        assert_eq!(fetch_notices(&base), Ok(NativeNotices::default()));
    }

    #[test]
    fn a_server_error_is_an_error_so_a_live_banner_stays() {
        // [2026-10-15] A 5xx (for example while the backend restarts) must not clear the banner that announced the restart.
        let (base, _requests) = mock_backend(vec![(503, "unavailable".to_string())]);
        assert!(fetch_notices(&base).is_err());
    }

    #[test]
    fn an_unreachable_backend_is_an_error_so_the_last_answer_stays() {
        // A port nothing listens on: the connection is refused at once.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert!(fetch_notices(&format!("http://127.0.0.1:{port}")).is_err());
    }

    #[test]
    fn a_readable_answer_is_parsed_with_its_fields() {
        let (base, _requests) = mock_backend(vec![(
            200,
            json!({
                "announcements": [{
                    "id": "restart", "text": "The backend service will restart at {time}.", "tone": "warning",
                    "eventAt": "2026-10-16T00:00:00.000Z", "showFrom": "2026-10-15T00:00:00.000Z",
                    "showUntil": "2026-10-16T00:30:00.000Z"
                }],
                "tags": [{ "id": "exp", "text": "EXPERIMENTAL BUILD", "tone": "warning" }],
                "serverTime": "2026-10-15T12:00:00.000Z"
            })
            .to_string(),
        )]);
        let notices = fetch_notices(&base).unwrap();
        assert_eq!(
            notices.announcements,
            vec![NativeAnnouncement {
                id: "restart".to_string(),
                text: "The backend service will restart at {time}.".to_string(),
                tone: AnnouncementTone::Warning,
                event_at: Some("2026-10-16T00:00:00.000Z".to_string()),
            }]
        );
        assert_eq!(
            notices.tags,
            vec![NativeTag {
                id: "exp".to_string(),
                text: "EXPERIMENTAL BUILD".to_string(),
                tone: TagTone::Warning,
            }]
        );
    }

    #[test]
    fn unknown_tones_are_dropped_for_both_kinds() {
        let notices = parsed(json!({
            "announcements": [announcement("a1", "Hello", "danger"), announcement("a2", "Hi", "critical")],
            "tags": [tag("t1", "NEW", "critical"), tag("t2", "BETA", "danger")],
        }));
        assert_eq!(notices.announcements.len(), 1);
        assert_eq!(notices.announcements[0].id, "a2");
        assert_eq!(notices.announcements[0].tone, AnnouncementTone::Critical);
        assert_eq!(notices.tags.len(), 1);
        assert_eq!(notices.tags[0].tone, TagTone::Danger);
    }

    #[test]
    fn empty_and_over_long_texts_are_dropped_and_the_limits_are_exact() {
        let at_limit = "x".repeat(280);
        let too_long = "x".repeat(281);
        let notices = parsed(json!({
            "announcements": [
                announcement("blank", "   ", "info"),
                announcement("long", &too_long, "info"),
                announcement("edge", &at_limit, "info"),
            ],
            "tags": [
                tag("tlong", &"y".repeat(25), "info"),
                tag("tedge", &"y".repeat(24), "info"),
            ],
        }));
        assert_eq!(notices.announcements.len(), 1);
        assert_eq!(notices.announcements[0].id, "edge");
        assert_eq!(notices.announcements[0].text.chars().count(), 280);
        assert_eq!(notices.tags.len(), 1);
        assert_eq!(notices.tags[0].id, "tedge");
    }

    #[test]
    fn control_characters_become_spaces_and_runs_of_spaces_collapse() {
        let notices = parsed(json!({
            "announcements": [announcement("a", "Maintenance\n\tnow\u{0}  today ", "info")],
            "tags": [],
        }));
        assert_eq!(notices.announcements[0].text, "Maintenance now today");
    }

    #[test]
    fn more_than_three_announcements_and_four_tags_keep_the_first_valid_ones() {
        let notices = parsed(json!({
            "announcements": [
                announcement("bad", "", "info"),
                announcement("a", "one", "info"),
                announcement("b", "two", "warning"),
                announcement("c", "three", "critical"),
                announcement("d", "four", "info"),
            ],
            "tags": [
                tag("t1", "ONE", "info"),
                tag("t2", "TWO", "warning"),
                tag("t3", "THREE", "danger"),
                tag("t4", "FOUR", "success"),
                tag("t5", "FIVE", "info"),
            ],
        }));
        let announcement_ids: Vec<&str> = notices
            .announcements
            .iter()
            .map(|a| a.id.as_str())
            .collect();
        assert_eq!(announcement_ids, ["a", "b", "c"]);
        let tag_ids: Vec<&str> = notices.tags.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(tag_ids, ["t1", "t2", "t3", "t4"]);
    }

    #[test]
    fn a_missing_or_unreadable_event_time_keeps_the_announcement_without_one() {
        let notices = parsed(json!({
            "announcements": [
                { "id": "none", "text": "Notice", "tone": "info" },
                { "id": "number", "text": "Notice", "tone": "info", "eventAt": 1234 },
                { "id": "dated", "text": "Notice {time}", "tone": "info", "eventAt": "2026-10-16T00:00:00Z" },
            ],
            "tags": [],
        }));
        assert_eq!(notices.announcements.len(), 3);
        assert_eq!(notices.announcements[0].event_at, None);
        assert_eq!(notices.announcements[1].event_at, None);
        assert_eq!(
            notices.announcements[2].event_at.as_deref(),
            Some("2026-10-16T00:00:00Z")
        );
        // A blank time is no time, and the announcement is still shown.
        let blank = parsed(json!({
            "announcements": [{ "id": "blank", "text": "Notice", "tone": "info", "eventAt": "  " }],
            "tags": [],
        }));
        assert_eq!(blank.announcements.len(), 1);
        assert_eq!(blank.announcements[0].event_at, None);
    }

    #[test]
    fn malformed_items_are_dropped_and_their_neighbours_kept() {
        let notices = parsed(json!({
            "announcements": [
                "not an object",
                { "id": "no-tone", "text": "x" },
                { "id": "text-number", "text": 7, "tone": "info" },
                { "id": "tone-number", "text": "x", "tone": 3 },
                announcement("ok", "Still here", "info"),
            ],
            "tags": [null, [1, 2], tag("ok-tag", "KEPT", "success")],
        }));
        assert_eq!(notices.announcements.len(), 1);
        assert_eq!(notices.announcements[0].id, "ok");
        assert_eq!(notices.tags.len(), 1);
        assert_eq!(notices.tags[0].text, "KEPT");
    }

    #[test]
    fn a_missing_id_gets_a_stand_in_and_a_repeated_id_is_shown_once() {
        let notices = parsed(json!({
            "announcements": [
                { "text": "No id", "tone": "info" },
                announcement("same", "first", "info"),
                announcement("same", "second", "warning"),
            ],
            "tags": [],
        }));
        assert_eq!(notices.announcements.len(), 2);
        assert_eq!(notices.announcements[0].id, "notice-0");
        assert_eq!(notices.announcements[1].text, "first");
    }

    #[test]
    fn a_body_that_is_not_the_contract_means_no_notices() {
        assert_eq!(
            parse_notices(b"<html>not json</html>"),
            NativeNotices::default()
        );
        assert_eq!(parse_notices(b"[]"), NativeNotices::default());
        assert_eq!(
            parse_notices(br#"{"announcements":"soon","tags":{}}"#),
            NativeNotices::default()
        );
        assert_eq!(parse_notices(b""), NativeNotices::default());
    }
}
