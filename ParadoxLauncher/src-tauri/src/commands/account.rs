// Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
// Licensed under the GNU Affero General Public License v3.0.
// SPDX-License-Identifier: AGPL-3.0-only
// Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.

//! [2026-10-14] The Terms of Use and Privacy Policy, and account deletion, on the official Mystic Paradox backend.
//!
//! Official accounts only: the official server and Paradox realms use the official backend. A LOCAL server keeps its own
//! accounts and rules, so these commands refuse it before anything is sent. Every call uses the official session
//! (`send_authorized_with`), and the backend keeps these routes open for a deactivated account, so it can read and
//! restore itself.
//!
//!   GET / POST  /launcher/v1/account/consent     the accepted Terms of Use and Privacy Policy versions
//!   GET / POST / DELETE  /launcher/v1/account/deletion   read; request (POST, `confirmUsername`); restore (DELETE)
//!
//! A backend without these routes answers 404. The status is then `supported: false`: no consent gate and no deletion
//! offer, so an older backend never locks a player out.

use reqwest::blocking::Response;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::auth::scope::{self, AuthScope};
use crate::commands::auth::{
    api_error_message, error_code_of, http_client_for, run_auth_task, send_authorized_with,
    AppHost, SessionHost, LAUNCHER_UPDATE_REQUIRED,
};
use crate::servers;

const CONSENT_PATH: &str = "/launcher/v1/account/consent";
const DELETION_PATH: &str = "/launcher/v1/account/deletion";
/// The refusal code of a deactivated account (a deletion was requested): the game, the realm, hub and host routes all send it.
pub(crate) const ACCOUNT_DEACTIVATED: &str = "ACCOUNT_DEACTIVATED";
/// The sentence for a deactivated account whose deletion day the backend did not send (or sent unreadable).
pub(crate) const DEACTIVATED_WITHOUT_DATE: &str =
    "Your account is deactivated and scheduled for deletion.";
const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const ON_OFFICIAL_ONLY: &str = "Terms and account deletion belong to Mystic Paradox accounts. This server keeps its own accounts and rules.";
const AGE_NOT_CONFIRMED: &str = "Confirm that you are old enough to create an account.";
const LEGAL_NOT_VALID: &str = "The launcher's legal documents are not valid. Update the launcher.";
const UNREACHABLE: &str = "Couldn't reach the Mystic Paradox account server.";
const INVALID_RESPONSE: &str = "The account server returned an invalid response.";
const DEFAULT_HOLD_DAYS: u32 = 30;

/// The versions the account must accept, and the minimum age, as the backend states them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegalRequirements {
    pub terms_version: String,
    pub privacy_version: String,
    pub minimum_age: u32,
}

/// What the account accepted, and when.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentRecord {
    pub terms_version: String,
    pub privacy_version: String,
    #[serde(default)]
    pub age_confirmed: bool,
    #[serde(default)]
    pub accepted_at: String,
}

/// The consent state the UI reads (`native_consent_status`, and the answer to an acceptance).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeConsentStatus {
    /// False when the backend has no consent routes: no gate is shown.
    pub supported: bool,
    pub required: Option<LegalRequirements>,
    pub accepted: Option<ConsentRecord>,
    pub up_to_date: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletionRequest {
    pub requested_at: String,
    pub scheduled_for: String,
}

/// The deletion state the UI reads. `supported: false` means the backend has no deletion route.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDeletionStatus {
    pub supported: bool,
    pub hold_days: u32,
    pub request: Option<DeletionRequest>,
}

/// The acceptance the launcher sends (POST), and the one a registration carries. Built only by `checked_consent`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConsentRequest {
    pub terms_version: String,
    pub privacy_version: String,
    pub age_confirmed: bool,
}

/// The acceptance a registration names, as the WebView sends it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeConsentInput {
    pub terms_version: String,
    pub privacy_version: String,
    pub age_confirmed: bool,
}

impl NativeConsentInput {
    pub(crate) fn into_request(self) -> Result<ConsentRequest, String> {
        checked_consent(self.terms_version, self.privacy_version, self.age_confirmed)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsentBody {
    required: LegalRequirements,
    accepted: Option<ConsentRecord>,
    up_to_date: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeletionBody {
    request: Option<DeletionRequest>,
    #[serde(default = "default_hold_days")]
    hold_days: u32,
}

fn default_hold_days() -> u32 {
    DEFAULT_HOLD_DAYS
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeletionConfirm<'a> {
    confirm_username: &'a str,
}

/// A legal version is a short token such as `2026-10-14`. Anything else is refused before it reaches the backend.
fn is_legal_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
}

/// An ISO 8601 date-time as the backend writes it: digits and `-:.TZ+` only, at most 40 characters.
pub(crate) fn is_timestamp(value: &str) -> bool {
    value.len() <= 40
        && value.contains('T')
        && value
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '-' | ':' | '.' | 'T' | 'Z' | '+'))
}

/// The acceptance the player named, checked: both versions well formed, and the age confirmed.
pub(crate) fn checked_consent(
    terms_version: String,
    privacy_version: String,
    age_confirmed: bool,
) -> Result<ConsentRequest, String> {
    if !is_legal_version(&terms_version) || !is_legal_version(&privacy_version) {
        return Err(LEGAL_NOT_VALID.to_string());
    }
    if !age_confirmed {
        return Err(AGE_NOT_CONFIRMED.to_string());
    }
    Ok(ConsentRequest {
        terms_version,
        privacy_version,
        age_confirmed,
    })
}

/// Reads a consent answer. A 404 is a backend without consent routes; any other refusal is read through the shared table.
pub(crate) fn parse_consent(status: u16, body: &[u8]) -> Result<NativeConsentStatus, String> {
    if status == 404 {
        return Ok(NativeConsentStatus {
            supported: false,
            required: None,
            accepted: None,
            up_to_date: true,
        });
    }
    if !(200..300).contains(&status) {
        // The backend's own answer when the launcher did not name both versions: the launcher is out of step.
        if error_code_of(body).as_deref() == Some("AUTH_VALIDATION_FAILED") {
            return Err(LAUNCHER_UPDATE_REQUIRED.to_string());
        }
        return Err(api_error_message(
            status,
            error_code_of(body).as_deref(),
            "Couldn't read your Terms of Use status.",
        ));
    }
    let parsed: ConsentBody =
        serde_json::from_slice(body).map_err(|_| INVALID_RESPONSE.to_string())?;
    Ok(NativeConsentStatus {
        supported: true,
        required: Some(parsed.required),
        accepted: parsed.accepted,
        up_to_date: parsed.up_to_date,
    })
}

/// Reads a deletion answer (the GET, POST and DELETE share one shape). A 404 is a backend without the deletion route.
pub(crate) fn parse_deletion(status: u16, body: &[u8]) -> Result<NativeDeletionStatus, String> {
    if status == 404 {
        return Ok(NativeDeletionStatus {
            supported: false,
            hold_days: DEFAULT_HOLD_DAYS,
            request: None,
        });
    }
    if !(200..300).contains(&status) {
        return Err(api_error_message(
            status,
            error_code_of(body).as_deref(),
            "Couldn't read your account deletion status.",
        ));
    }
    let parsed: DeletionBody =
        serde_json::from_slice(body).map_err(|_| INVALID_RESPONSE.to_string())?;
    Ok(NativeDeletionStatus {
        supported: true,
        hold_days: parsed.hold_days,
        request: parsed.request,
    })
}

/// The day an account is deleted, written the way the launcher shows it: "13 November 2026", in UTC. `None` for anything
/// that is not a timestamp.
pub(crate) fn format_deletion_day(value: &str) -> Option<String> {
    if !is_timestamp(value) {
        return None;
    }
    let parsed =
        time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()?;
    let utc = parsed.to_offset(time::UtcOffset::UTC);
    let month = MONTHS[usize::from(u8::from(utc.month())) - 1];
    Some(format!("{} {} {}", utc.day(), month, utc.year()))
}

/// The sentence for a refusal of a deactivated account, with the day it is deleted when the backend sent one. `None` for
/// every other refusal. Each surface shows this same text, so the realm, hub and game refusals read like the Account page.
pub(crate) fn deactivated_message(body: &[u8]) -> Option<String> {
    let envelope: serde_json::Value = serde_json::from_slice(body).ok()?;
    deactivated_sentence(&envelope["error"])
}

/// The same sentence, read from an `error` object (its `code` and `scheduledFor`).
pub(crate) fn deactivated_sentence(error: &serde_json::Value) -> Option<String> {
    if error["code"].as_str()? != ACCOUNT_DEACTIVATED {
        return None;
    }
    Some(
        match error["scheduledFor"].as_str().and_then(format_deletion_day) {
            Some(day) => format!("Your account is deactivated and will be deleted on {day}."),
            None => DEACTIVATED_WITHOUT_DATE.to_string(),
        },
    )
}

/// The account these commands act on must be an official one (the official server or a Paradox realm).
fn require_official(scope: AuthScope) -> Result<AuthScope, String> {
    if scope.is_official() {
        Ok(scope)
    } else {
        Err(ON_OFFICIAL_ONLY.to_string())
    }
}

/// The selected server's official account scope, read before any network call.
fn official_account_scope(app: &AppHandle, server_id: Option<&str>) -> Result<AuthScope, String> {
    require_official(scope::scope_for(&servers::store::load(app), server_id)?)
}

/// GET (no body) or POST (the acceptance) of the consent route, with `scope`'s session.
fn consent_request(
    host: &dyn SessionHost,
    scope: &AuthScope,
    body: Option<&ConsentRequest>,
) -> Result<NativeConsentStatus, String> {
    let response = send_authorized_with(host, scope, |token| {
        let url = format!("{}{CONSENT_PATH}", scope.base_url());
        let request = match body {
            Some(body) => http_client_for(scope)?.post(url).json(body),
            None => http_client_for(scope)?.get(url),
        };
        request
            .bearer_auth(token)
            .send()
            .map_err(|_| UNREACHABLE.to_string())
    })?;
    let status = response.status().as_u16();
    let bytes = response_bytes(response);
    parse_consent(status, &bytes)
}

/// GET, POST (`confirm` is the typed username) or DELETE of the deletion route, with `scope`'s session.
fn deletion_request(
    host: &dyn SessionHost,
    scope: &AuthScope,
    method: reqwest::Method,
    confirm: Option<&str>,
) -> Result<NativeDeletionStatus, String> {
    let response = send_authorized_with(host, scope, |token| {
        let url = format!("{}{DELETION_PATH}", scope.base_url());
        let mut request = http_client_for(scope)?
            .request(method.clone(), url)
            .bearer_auth(token);
        if let Some(username) = confirm {
            request = request.json(&DeletionConfirm {
                confirm_username: username,
            });
        }
        request.send().map_err(|_| UNREACHABLE.to_string())
    })?;
    let status = response.status().as_u16();
    let bytes = response_bytes(response);
    parse_deletion(status, &bytes)
}

fn response_bytes(response: Response) -> Vec<u8> {
    response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn native_consent_status(
    app: AppHandle,
    server_id: Option<String>,
) -> Result<NativeConsentStatus, String> {
    run_auth_task(move || {
        let scope = official_account_scope(&app, server_id.as_deref())?;
        consent_request(&AppHost(&app), &scope, None)
    })
    .await
}

/// The player's acceptance of the documents the launcher shows. The backend answers 409 LEGAL_VERSION_OUTDATED when the
/// versions are not the current ones (the launcher must be updated).
#[tauri::command]
pub async fn native_accept_consent(
    app: AppHandle,
    server_id: Option<String>,
    terms_version: String,
    privacy_version: String,
    age_confirmed: bool,
) -> Result<NativeConsentStatus, String> {
    run_auth_task(move || {
        let scope = official_account_scope(&app, server_id.as_deref())?;
        let body = checked_consent(terms_version, privacy_version, age_confirmed)?;
        consent_request(&AppHost(&app), &scope, Some(&body))
    })
    .await
}

#[tauri::command]
pub async fn native_deletion_status(
    app: AppHandle,
    server_id: Option<String>,
) -> Result<NativeDeletionStatus, String> {
    run_auth_task(move || {
        let scope = official_account_scope(&app, server_id.as_deref())?;
        deletion_request(&AppHost(&app), &scope, reqwest::Method::GET, None)
    })
    .await
}

/// Deactivates the account at once and schedules its deletion. `confirm_username` must be the account's username.
#[tauri::command]
pub async fn native_request_deletion(
    app: AppHandle,
    server_id: Option<String>,
    confirm_username: String,
) -> Result<NativeDeletionStatus, String> {
    run_auth_task(move || {
        let scope = official_account_scope(&app, server_id.as_deref())?;
        deletion_request(
            &AppHost(&app),
            &scope,
            reqwest::Method::POST,
            Some(&confirm_username),
        )
    })
    .await
}

/// Restores a deactivated account while its hold lasts.
#[tauri::command]
pub async fn native_cancel_deletion(
    app: AppHandle,
    server_id: Option<String>,
) -> Result<NativeDeletionStatus, String> {
    run_auth_task(move || {
        let scope = official_account_scope(&app, server_id.as_deref())?;
        deletion_request(&AppHost(&app), &scope, reqwest::Method::DELETE, None)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::session_epoch;
    use crate::commands::auth::{cache_access, NativeAccount, NativeSession};
    use crate::commands::test_support::{access_token, error_json, mock_backend};

    const CONSENT_JSON: &str = r#"{"required":{"termsVersion":"2026-10-14","privacyVersion":"2026-10-14","minimumAge":16},"accepted":{"termsVersion":"2026-09-01","privacyVersion":"2026-09-01","ageConfirmed":true,"acceptedAt":"2026-09-01T10:00:00.000Z"},"upToDate":false}"#;

    /// No token refresh is ever needed in these tests: the access token is seeded in the cache.
    struct NoHost;

    impl SessionHost for NoHost {
        fn load_token(&self, _: &AuthScope) -> Result<Option<String>, String> {
            Ok(None)
        }
        fn save_token(&self, _: &AuthScope, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn clear_token(&self, _: &AuthScope) -> Result<(), String> {
            Ok(())
        }
        fn session_ended(&self, _: &AuthScope) {}
    }

    fn seeded_scope(id: &str, base: &str, label: &str) -> AuthScope {
        let scope = AuthScope::Local {
            id: id.to_string(),
            base_url: base.to_string(),
        };
        let session = NativeSession {
            access_token: access_token(label),
            refresh_token: "unused".into(),
            account: NativeAccount {
                user_id: format!("user-{label}"),
                display_name: "Slayer".into(),
                email: "slayer@example.com".into(),
                discord_linked: false,
                status: "active".into(),
                approval_status: "approved".into(),
                needs_username: false,
                discord: None,
            },
        };
        cache_access(&scope, session_epoch::current(scope.key()), &session);
        scope
    }

    // ---- the consent answer -------------------------------------------------------------------------------

    #[test]
    fn the_consent_answer_names_what_is_required_and_what_was_accepted() {
        let status = parse_consent(200, CONSENT_JSON.as_bytes()).unwrap();
        assert!(status.supported);
        assert!(!status.up_to_date, "the accepted versions are older");
        let required = status.required.unwrap();
        assert_eq!(required.terms_version, "2026-10-14");
        assert_eq!(required.privacy_version, "2026-10-14");
        assert_eq!(required.minimum_age, 16);
        let accepted = status.accepted.unwrap();
        assert_eq!(accepted.terms_version, "2026-09-01");
        assert!(accepted.age_confirmed);
        assert_eq!(accepted.accepted_at, "2026-09-01T10:00:00.000Z");
    }

    #[test]
    fn a_backend_without_consent_routes_is_never_a_gate() {
        let status = parse_consent(404, &error_json("NOT_FOUND").into_bytes()).unwrap();
        assert!(!status.supported);
        assert!(status.up_to_date);
        assert!(status.required.is_none() && status.accepted.is_none());
    }

    #[test]
    fn an_outdated_launcher_is_told_to_update() {
        let error =
            parse_consent(409, &error_json("LEGAL_VERSION_OUTDATED").into_bytes()).unwrap_err();
        assert_eq!(error, LAUNCHER_UPDATE_REQUIRED);
        // Missing versions are the launcher's fault too (the backend answers AUTH_VALIDATION_FAILED).
        assert_eq!(
            parse_consent(400, &error_json("AUTH_VALIDATION_FAILED").into_bytes()).unwrap_err(),
            LAUNCHER_UPDATE_REQUIRED
        );
        assert!(error.starts_with("Update the launcher"));
    }

    #[test]
    fn a_consent_answer_that_is_not_json_is_refused_plainly() {
        assert_eq!(
            parse_consent(200, b"<html>"),
            Err(INVALID_RESPONSE.to_string())
        );
        let other = parse_consent(500, b"not json").unwrap_err();
        assert!(
            other.starts_with("Couldn't read your Terms of Use status."),
            "{other}"
        );
    }

    // ---- the acceptance -------------------------------------------------------------------------------------

    #[test]
    fn an_acceptance_names_well_formed_versions_and_the_age() {
        assert_eq!(
            checked_consent("2026-10-14".into(), "2026-10-14".into(), false),
            Err(AGE_NOT_CONFIRMED.to_string())
        );
        let long = "x".repeat(33);
        for bad in ["", "../2026", "2026 10 14", long.as_str()] {
            assert_eq!(
                checked_consent(bad.into(), "2026-10-14".into(), true),
                Err(LEGAL_NOT_VALID.to_string()),
                "{bad}"
            );
        }
        let accepted = checked_consent("2026-10-14".into(), "2026-10-14.1".into(), true).unwrap();
        let json = serde_json::to_value(&accepted).unwrap();
        assert_eq!(json["termsVersion"], "2026-10-14");
        assert_eq!(json["privacyVersion"], "2026-10-14.1");
        assert_eq!(json["ageConfirmed"], true);
    }

    // ---- the deletion answer ---------------------------------------------------------------------------------

    #[test]
    fn the_deletion_answer_gives_the_scheduled_day_and_the_hold() {
        let body = r#"{"request":{"requestedAt":"2026-10-14T09:00:00.000Z","scheduledFor":"2026-11-13T09:00:00.000Z"},"holdDays":30}"#;
        let status = parse_deletion(200, body.as_bytes()).unwrap();
        assert!(status.supported);
        assert_eq!(status.hold_days, 30);
        let request = status.request.unwrap();
        assert_eq!(request.scheduled_for, "2026-11-13T09:00:00.000Z");
        assert_eq!(request.requested_at, "2026-10-14T09:00:00.000Z");
    }

    #[test]
    fn no_deletion_request_is_an_active_account() {
        let status = parse_deletion(200, br#"{"request":null,"holdDays":30}"#).unwrap();
        assert!(status.supported);
        assert!(status.request.is_none());
    }

    #[test]
    fn a_missing_deletion_route_is_unavailable_not_an_error() {
        let status = parse_deletion(404, &error_json("NOT_FOUND").into_bytes()).unwrap();
        assert!(!status.supported);
        assert!(status.request.is_none());
    }

    #[test]
    fn a_mistyped_username_is_refused_without_repeating_it() {
        let error = parse_deletion(
            400,
            &error_json("DELETION_CONFIRMATION_MISMATCH").into_bytes(),
        )
        .unwrap_err();
        assert_eq!(
            error,
            "Type your username exactly as it is shown to confirm."
        );
    }

    // ---- a play refused for a deactivated account ----------------------------------------------------------

    #[test]
    fn a_refused_play_names_the_day_the_account_is_deleted() {
        let body = r#"{"error":{"code":"ACCOUNT_DEACTIVATED","message":"x","requestId":"r","scheduledFor":"2026-11-13T09:00:00.000Z"}}"#;
        assert_eq!(
            deactivated_message(body.as_bytes()).as_deref(),
            Some("Your account is deactivated and will be deleted on 13 November 2026.")
        );
        // The day is read in UTC, so a time near midnight keeps its UTC day.
        let late = r#"{"error":{"code":"ACCOUNT_DEACTIVATED","scheduledFor":"2026-11-13T23:30:00-02:00"}}"#;
        assert_eq!(
            deactivated_message(late.as_bytes()).as_deref(),
            Some("Your account is deactivated and will be deleted on 14 November 2026.")
        );
    }

    #[test]
    fn a_refused_play_without_a_usable_date_still_says_deactivated() {
        let hostile =
            r#"{"error":{"code":"ACCOUNT_DEACTIVATED","scheduledFor":"javascript:alert(1)"}}"#;
        assert_eq!(
            deactivated_message(hostile.as_bytes()).as_deref(),
            Some(DEACTIVATED_WITHOUT_DATE)
        );
        let missing = r#"{"error":{"code":"ACCOUNT_DEACTIVATED"}}"#;
        assert_eq!(
            deactivated_message(missing.as_bytes()).as_deref(),
            Some(DEACTIVATED_WITHOUT_DATE)
        );
    }

    #[test]
    fn other_refusals_are_not_deactivations() {
        assert_eq!(
            deactivated_message(&error_json("GUARD_REQUIRED").into_bytes()),
            None
        );
        assert_eq!(deactivated_message(b"not json"), None);
        assert_eq!(deactivated_message(br#"{"error":{}}"#), None);
    }

    #[test]
    fn a_local_server_never_gets_the_official_account_commands() {
        let local = AuthScope::Local {
            id: "s-account-local".into(),
            base_url: "https://realm.example.com:8443".into(),
        };
        assert_eq!(require_official(local), Err(ON_OFFICIAL_ONLY.to_string()));
        assert_eq!(
            require_official(AuthScope::Official),
            Ok(AuthScope::Official)
        );
    }

    #[test]
    fn timestamps_must_look_like_the_backends_dates() {
        assert!(is_timestamp("2026-11-13T09:00:00.000Z"));
        assert!(is_timestamp("2026-11-13T09:00:00+01:00"));
        assert!(!is_timestamp("2026-11-13"));
        assert!(!is_timestamp("<b>T</b>"));
        assert!(!is_timestamp(&format!("{}T", "1".repeat(41))));
    }

    // ---- the routes, with the session of the scope ----------------------------------------------------------

    #[test]
    fn the_consent_routes_send_the_scopes_token_and_the_checked_acceptance() {
        let (base, requests) = mock_backend(vec![
            (200, CONSENT_JSON.to_string()),
            (200, CONSENT_JSON.to_string()),
        ]);
        let scope = seeded_scope("s-account-consent-route", &base, "consent");

        let read = consent_request(&NoHost, &scope, None).unwrap();
        assert!(!read.up_to_date);
        let get = requests.recv().unwrap();
        assert_eq!(get.method, "get");
        assert_eq!(get.path, "/launcher/v1/account/consent");
        assert!(get.text.contains(&access_token("consent").to_lowercase()));

        let body = checked_consent("2026-10-14".into(), "2026-10-14".into(), true).unwrap();
        consent_request(&NoHost, &scope, Some(&body)).unwrap();
        let post = requests.recv().unwrap();
        assert_eq!(post.method, "post");
        assert_eq!(post.path, "/launcher/v1/account/consent");
        assert!(
            post.text.contains("\"termsversion\":\"2026-10-14\""),
            "{}",
            post.text
        );
        assert!(post.text.contains("\"ageconfirmed\":true"), "{}", post.text);
    }

    #[test]
    fn the_deletion_routes_use_their_method_and_send_the_typed_username_once() {
        let (base, requests) = mock_backend(vec![
            (
                200,
                r#"{"request":{"requestedAt":"a","scheduledFor":"b"},"holdDays":30}"#.to_string(),
            ),
            (200, r#"{"request":null,"holdDays":30}"#.to_string()),
            (200, r#"{"request":null,"holdDays":30}"#.to_string()),
        ]);
        let scope = seeded_scope("s-account-deletion-route", &base, "deletion");

        let requested =
            deletion_request(&NoHost, &scope, reqwest::Method::POST, Some("Slayer")).unwrap();
        assert!(requested.request.is_some());
        let post = requests.recv().unwrap();
        assert_eq!(post.method, "post");
        assert_eq!(post.path, "/launcher/v1/account/deletion");
        assert!(
            post.text.contains("\"confirmusername\":\"slayer\""),
            "{}",
            post.text
        );

        deletion_request(&NoHost, &scope, reqwest::Method::GET, None).unwrap();
        assert_eq!(requests.recv().unwrap().method, "get");

        let restored = deletion_request(&NoHost, &scope, reqwest::Method::DELETE, None).unwrap();
        assert!(restored.request.is_none());
        let delete = requests.recv().unwrap();
        assert_eq!(delete.method, "delete");
        assert!(
            !delete.text.contains("confirmusername"),
            "a restore sends no username"
        );
    }
}
