// [2026-10-14 realms] The realm directory's lookup: who hosts a Paradox realm (its public key and display name), and whether the
// name now belongs to a different key than the one the player agreed to. Used by the host confirmation (when a realm is added,
// and at the first Play) and by the ownership warning. It asks our backend with the official sign-in, as every realm call does
// (`GET /launcher/v1/realms/by-name/:name?knownHostKey=`, SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md section 2.1).
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::model::{key_fingerprint, validate_host_key};
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
    })
}

/// The sentence for a refused lookup: the directory's own message (it is written for players), or a plain status line.
fn refusal_text(status: u16, body: &[u8]) -> String {
    // [2026-10-14] A deactivated account is refused the same way everywhere: the day its deletion is set.
    if let Some(sentence) = crate::commands::account::deactivated_message(body) {
        return sentence;
    }
    let message = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
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

        // No key was sent: the directory leaves the field out, and a blank display name is no name.
        let body = br#"{"realm":{"name":"ember-hold","host":{"displayName":"  "},
            "hostPublicKey":"KEY-0123456789abcdef"}}"#;
        let view = parse_lookup(body).unwrap();
        assert_eq!(view.host_name, None);
        assert!(!view.ownership_changed);
        assert!(!view.online);
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
