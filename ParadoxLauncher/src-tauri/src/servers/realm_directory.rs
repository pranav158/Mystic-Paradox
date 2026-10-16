// [2026-10-14 realms] The realm directory's lookup: who hosts a Paradox realm (its public key and display name), and whether the
// name now belongs to a different key than the one the player agreed to. Used by the host confirmation (when a realm is added,
// and at the first Play) and by the ownership warning. It asks our backend with the official sign-in, as every realm call does
// (`GET /launcher/v1/realms/by-name/:name?knownHostKey=`, SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md section 2.1).
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::model::{key_fingerprint, validate_host_key, validate_realm_name};
use crate::commands::auth::{api_base_url, http_client, send_authorized};

/// `{ realm: RealmPublicInfo }`, reduced to what the launcher reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LookupEnvelope {
    realm: RealmInfo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RealmInfo {
    name: String,
    host: HostInfo,
    host_public_key: String,
    #[serde(default)]
    online: bool,
    #[serde(default)]
    serving: bool,
    /// Only answered when the request carried the key the launcher knows (`knownHostKey`).
    #[serde(default)]
    ownership_changed: bool,
    /// The player's own standing: `HOST`, `MEMBER` or none.
    #[serde(default)]
    membership: Option<String>,
    /// [2026-10-16] The player asked to join and waits for the host.
    #[serde(default)]
    requested: bool,
    /// [2026-10-16] The host invited the player and the player has not answered.
    #[serde(default)]
    invited: bool,
    /// [2026-10-16] Who may join: `PUBLIC` (anyone signed in; Play joins) or `INVITE_ONLY` (approved players).
    #[serde(default)]
    join_policy: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostInfo {
    display_name: Option<String>,
}

/// What the realm panel and the confirmation dialog show. The full key is kept so the player's "Join" stores exactly the
/// key that was shown (through `set_realm_host_key`), never a fresh one.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RealmLookupView {
    pub name: String,
    /// The host's display name, `None` when the directory has none.
    pub host_name: Option<String>,
    pub host_public_key: String,
    /// The short form of the key (`key_fingerprint`), for the player to compare.
    pub fingerprint: String,
    pub online: bool,
    pub serving: bool,
    /// The name now belongs to a different key than the one sent. Only meaningful when a key was sent.
    pub ownership_changed: bool,
    /// [2026-10-16] The player may enter (a member, or the host).
    pub member: bool,
    /// [2026-10-16] The player's join request waits for the host.
    pub requested: bool,
    /// [2026-10-16] The host invited the player and the player has not answered.
    pub invited: bool,
    /// [2026-10-16] The player is this realm's host (Home then reads the realm's state from this PC's own host when it can).
    pub own: bool,
    /// [2026-10-16] The realm's join policy as the directory names it (`PUBLIC` or `INVITE_ONLY`), when it does.
    pub join_policy: Option<String>,
}

/// Reads a successful lookup answer. A key of the wrong shape is refused, so nothing malformed is ever stored.
pub fn parse_lookup(body: &[u8]) -> Result<RealmLookupView, String> {
    let envelope: LookupEnvelope = serde_json::from_slice(body).map_err(|_| {
        "The realm directory answered in a form this launcher does not read.".to_string()
    })?;
    let info = envelope.realm;
    let key = validate_host_key(&info.host_public_key)?;
    Ok(RealmLookupView {
        name: info.name,
        host_name: info
            .host
            .display_name
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty()),
        fingerprint: key_fingerprint(&key),
        host_public_key: key,
        online: info.online,
        serving: info.serving,
        ownership_changed: info.ownership_changed,
        own: info.membership.as_deref() == Some("HOST"),
        join_policy: info.join_policy,
        member: info.membership.is_some(),
        requested: info.requested,
        invited: info.invited,
    })
}

/// The sentence for a refused lookup: the directory's own message (it is written for players), or a plain status line.
fn refusal_text(status: u16, body: &[u8]) -> String {
    // [2026-10-14] A deactivated account is refused the same way everywhere: the day its deletion is set.
    if let Some(sentence) = crate::commands::account::deactivated_message(body) {
        return sentence;
    }
    let value = serde_json::from_slice::<serde_json::Value>(body).ok();
    // [2026-10-16] Solo mode reads the same here as at Play.
    if value
        .as_ref()
        .and_then(|value| value["error"]["code"].as_str())
        == Some("REALM_SOLO")
    {
        return crate::commands::launch::REALM_SOLO_MESSAGE.to_string();
    }
    let message = value
        .and_then(|value| value["error"]["message"].as_str().map(str::to_string))
        .filter(|text| !text.trim().is_empty());
    message.unwrap_or_else(|| format!("The realm directory refused the request (status {status})."))
}

/// Looks `realm_name` up on our backend with the official sign-in. Without a sign-in the call fails with the usual
/// message, and the caller can still store the realm and confirm its host at the first Play.
pub fn lookup(
    app: &AppHandle,
    realm_name: &str,
    known_host_key: Option<&str>,
) -> Result<RealmLookupView, String> {
    let url = format!("{}/launcher/v1/realms/by-name/{realm_name}", api_base_url());
    let response = send_authorized(app, |token| {
        let mut request = http_client()?.get(&url).bearer_auth(token);
        if let Some(key) = known_host_key {
            request = request.query(&[("knownHostKey", key)]);
        }
        request
            .send()
            .map_err(|_| "Couldn't reach the Mystic Paradox server.".to_string())
    })?;
    let status = response.status();
    let body = response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .unwrap_or_default();
    if !status.is_success() {
        return Err(refusal_text(status.as_u16(), &body));
    }
    parse_lookup(&body)
}

// ---- [2026-10-16] Player invites and join requests, the player's side ----------------------------------------------------

/// `{ invites: [{ realm, at }] }`.
#[derive(Deserialize)]
struct InvitesEnvelope {
    #[serde(default)]
    invites: Vec<InviteEntry>,
}

#[derive(Deserialize)]
struct InviteEntry {
    realm: InviteRealm,
    at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InviteRealm {
    name: String,
    host: HostInfo,
    #[serde(default)]
    online: bool,
}

/// One invite the player received, as the Servers page shows it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RealmInviteView {
    pub realm_name: String,
    pub host_name: Option<String>,
    pub at: Option<String>,
    pub online: bool,
}

/// What a join request answered: the player may enter now, or the request waits for the host.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum JoinAnswer {
    Member,
    Requested,
}

pub fn parse_invites(body: &[u8]) -> Result<Vec<RealmInviteView>, String> {
    let envelope: InvitesEnvelope = serde_json::from_slice(body).map_err(|_| {
        "The realm directory answered in a form this launcher does not read.".to_string()
    })?;
    Ok(envelope
        .invites
        .into_iter()
        .map(|invite| RealmInviteView {
            realm_name: invite.realm.name,
            host_name: invite
                .realm
                .host
                .display_name
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty()),
            at: invite.at,
            online: invite.realm.online,
        })
        .collect())
}

/// A join answered 409 REALM_JOIN_REQUESTED: not a failure, the request was recorded (or already was).
fn is_join_requested(status: u16, body: &[u8]) -> bool {
    status == 409
        && serde_json::from_slice::<serde_json::Value>(body)
            .ok()
            .and_then(|value| value["error"]["code"].as_str().map(str::to_string))
            .as_deref()
            == Some("REALM_JOIN_REQUESTED")
}

fn send(
    app: &AppHandle,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<(u16, Vec<u8>), String> {
    let url = format!("{}{path}", api_base_url());
    let response = send_authorized(app, |token| {
        let mut request = http_client()?
            .request(method.clone(), &url)
            .bearer_auth(token);
        if let Some(body) = &body {
            request = request.json(body);
        }
        request
            .send()
            .map_err(|_| "Couldn't reach the Mystic Paradox server.".to_string())
    })?;
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .unwrap_or_default();
    Ok((status, bytes))
}

/// The invites the signed-in player has not answered (`GET /launcher/v1/realms/player-invites`).
pub fn player_invites(app: &AppHandle) -> Result<Vec<RealmInviteView>, String> {
    let (status, body) = send(
        app,
        reqwest::Method::GET,
        "/launcher/v1/realms/player-invites",
        None,
    )?;
    if !(200..300).contains(&status) {
        return Err(refusal_text(status, &body));
    }
    parse_invites(&body)
}

/// Accepts or declines an invite. The name is validated before it reaches a URL.
pub fn answer_invite(app: &AppHandle, realm_name: &str, accept: bool) -> Result<(), String> {
    let name = validate_realm_name(realm_name)?;
    let action = if accept { "accept" } else { "decline" };
    let (status, body) = send(
        app,
        reqwest::Method::POST,
        &format!("/launcher/v1/realms/player-invites/{name}/{action}"),
        Some(serde_json::json!({})),
    )?;
    if !(200..300).contains(&status) {
        return Err(refusal_text(status, &body));
    }
    Ok(())
}

/// Asks to join a realm by name (`POST /launcher/v1/realms/join`): a member (or a PUBLIC realm) answers MEMBER, an invite-only
/// realm records a request for its host and answers REQUESTED. The key the player agreed to is sent, so a new owner is refused.
pub fn request_join(
    app: &AppHandle,
    realm_name: &str,
    known_host_key: Option<&str>,
) -> Result<JoinAnswer, String> {
    let name = validate_realm_name(realm_name)?;
    let mut body = serde_json::json!({ "name": name });
    if let Some(key) = known_host_key {
        body["knownHostKey"] = serde_json::Value::String(key.to_string());
    }
    let (status, bytes) = send(
        app,
        reqwest::Method::POST,
        "/launcher/v1/realms/join",
        Some(body),
    )?;
    if (200..300).contains(&status) {
        return Ok(JoinAnswer::Member);
    }
    if is_join_requested(status, &bytes) {
        return Ok(JoinAnswer::Requested);
    }
    Err(refusal_text(status, &bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lookup_answer_is_read_with_its_fingerprint_and_ownership() {
        let body =
            br#"{"realm":{"realmId":"r1","name":"ember-hold","host":{"displayName":"Tempest"},
            "hostPublicKey":"KEY-0123456789abcdefghijklmnop","joinPolicy":"PUBLIC","listed":true,
            "online":true,"serving":false,"hubReady":false,"playerCount":0,"membership":null,
            "ownershipChanged":true}}"#;
        let view = parse_lookup(body).unwrap();
        assert_eq!(view.name, "ember-hold");
        assert_eq!(view.host_name.as_deref(), Some("Tempest"));
        assert_eq!(view.host_public_key, "KEY-0123456789abcdefghijklmnop");
        assert_eq!(view.fingerprint, "KEY-0123…ijklmnop");
        assert!(view.online && !view.serving && view.ownership_changed);
        assert_eq!(view.join_policy.as_deref(), Some("PUBLIC"));

        // No key was sent: the directory leaves the field out, and a blank display name is no name.
        let body = br#"{"realm":{"name":"ember-hold","host":{"displayName":"  "},
            "hostPublicKey":"KEY-0123456789abcdef"}}"#;
        let view = parse_lookup(body).unwrap();
        assert_eq!(view.host_name, None);
        assert_eq!(view.join_policy, None);
        assert!(!view.ownership_changed);
        assert!(!view.online);
    }

    #[test]
    fn a_solo_realm_refuses_in_the_launchers_words() {
        let body = br#"{"error":{"code":"REALM_SOLO","message":"Solo."}}"#;
        assert_eq!(
            refusal_text(409, body),
            crate::commands::launch::REALM_SOLO_MESSAGE
        );
        // Other refusals keep the directory's own sentence.
        let body =
            br#"{"error":{"code":"REALM_NAME_INVALID","message":"That realm name is not valid."}}"#;
        assert_eq!(refusal_text(400, body), "That realm name is not valid.");
    }

    #[test]
    fn a_lookup_says_whether_the_player_is_in_waits_or_is_invited() {
        let body = br#"{"realm":{"name":"ember-hold","host":{"displayName":"Tempest"},
            "hostPublicKey":"KEY-0123456789abcdef","membership":"MEMBER","requested":false,"invited":false}}"#;
        let view = parse_lookup(body).unwrap();
        assert!(view.member && !view.requested && !view.invited && !view.own);
        // [2026-10-16] The host's own lookup: a member, and its own realm.
        let body = br#"{"realm":{"name":"ember-hold","host":{"displayName":"Tempest"},
            "hostPublicKey":"KEY-0123456789abcdef","membership":"HOST"}}"#;
        let view = parse_lookup(body).unwrap();
        assert!(view.member && view.own);
        let body = br#"{"realm":{"name":"ember-hold","host":{"displayName":"Tempest"},
            "hostPublicKey":"KEY-0123456789abcdef","membership":null,"requested":true,"invited":true}}"#;
        let view = parse_lookup(body).unwrap();
        assert!(!view.member && view.requested && view.invited);
        // An older backend sends neither flag.
        let body =
            br#"{"realm":{"name":"ember-hold","host":{},"hostPublicKey":"KEY-0123456789abcdef"}}"#;
        let view = parse_lookup(body).unwrap();
        assert!(!view.member && !view.requested && !view.invited && !view.own);
    }

    #[test]
    fn invites_are_read_with_their_host_and_time() {
        let body = br#"{"invites":[{"realm":{"name":"ember-hold","host":{"displayName":"Tempest"},"online":true},
            "at":"2026-10-16T10:00:00.000Z"},{"realm":{"name":"quiet-vale","host":{"displayName":" "}},"at":null}]}"#;
        let invites = parse_invites(body).unwrap();
        assert_eq!(invites.len(), 2);
        assert_eq!(invites[0].realm_name, "ember-hold");
        assert_eq!(invites[0].host_name.as_deref(), Some("Tempest"));
        assert_eq!(invites[0].at.as_deref(), Some("2026-10-16T10:00:00.000Z"));
        assert!(invites[0].online);
        assert_eq!(invites[1].host_name, None);
        assert!(!invites[1].online);
        assert_eq!(parse_invites(br#"{}"#).unwrap(), Vec::new());
        assert!(parse_invites(b"<html>").is_err());
    }

    #[test]
    fn a_recorded_request_is_told_apart_from_a_refusal() {
        let requested =
            br#"{"error":{"code":"REALM_JOIN_REQUESTED","message":"Request sent to the host."}}"#;
        assert!(is_join_requested(409, requested));
        assert!(!is_join_requested(403, requested));
        assert!(!is_join_requested(
            409,
            br#"{"error":{"code":"REALM_FULL","message":"Full."}}"#
        ));
        assert!(!is_join_requested(409, b"not json"));
    }

    #[test]
    fn a_malformed_answer_or_key_is_refused() {
        assert!(parse_lookup(b"not json").is_err());
        assert!(
            parse_lookup(br#"{"realm":{"name":"x","host":{},"hostPublicKey":"short"}}"#).is_err()
        );
        assert!(parse_lookup(br#"{"realm":{"host":{}}}"#).is_err());
    }

    #[test]
    fn refusals_read_as_the_directory_said_them() {
        let body = br#"{"error":{"code":"REALM_NOT_FOUND","message":"There is no realm with that name.","requestId":"r"}}"#;
        assert_eq!(refusal_text(404, body), "There is no realm with that name.");
        // A deactivated account's lookup says the day its deletion is set, as every other route does.
        assert_eq!(
            refusal_text(
                403,
                br#"{"error":{"code":"ACCOUNT_DEACTIVATED","message":"x","scheduledFor":"2026-11-13T09:00:00.000Z"}}"#
            ),
            "Your account is deactivated and will be deleted on 13 November 2026."
        );
        assert_eq!(
            refusal_text(502, b"<html>"),
            "The realm directory refused the request (status 502)."
        );
        assert_eq!(
            refusal_text(409, br#"{"error":{"code":"X","message":""}}"#),
            "The realm directory refused the request (status 409)."
        );
    }
}
