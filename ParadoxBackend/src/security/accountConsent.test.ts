import assert from "node:assert/strict";
import test from "node:test";
import type { Response } from "express";
import type { LauncherAccountRecord } from "../persistence/contracts/LauncherAccountRepository";
import { CurrentLegalRequirements } from "../legal/legalPolicy";
import {
    AssertAccountNotDeactivated,
    AssertConsentCurrentWhenEnforced,
    ConsentEnforced,
    ConsentRequiredAtSignUp,
    IsConsentCurrent,
    ValidateRegistrationConsent
} from "./accountConsent";
import { LauncherApiError, SendLauncherError } from "./launcherErrors";

const NOW = "2026-10-14T12:00:00.000Z";
const CURRENT = CurrentLegalRequirements();
const CONSENT = { termsVersion: CURRENT.termsVersion, privacyVersion: CURRENT.privacyVersion, ageConfirmed: true as const, acceptedAt: NOW };
const MONGO = { PERSISTENCE_PROVIDER: "mongodb" } as NodeJS.ProcessEnv;
const SQLITE = { PERSISTENCE_PROVIDER: "sqlite" } as NodeJS.ProcessEnv;

function Account(overrides: Partial<LauncherAccountRecord> = {}): LauncherAccountRecord {
    return { userId: "account-1", displayNameNormalized: "slayer", displayName: "Slayer", status: "active", roles: ["player"], createdAt: NOW, ...overrides };
}

function RefusalOf(action: () => unknown): LauncherApiError {
    try {
        action();
    } catch (error) {
        assert.ok(error instanceof LauncherApiError, String(error));
        return error;
    }
    assert.fail("expected a refusal");
}

// Records what SendLauncherError sends: the status and the JSON body.
function FakeResponse(): { statusCode?: number; body?: any; status(code: number): unknown; json(body: unknown): unknown } {
    const Reply: { statusCode?: number; body?: any; status(code: number): unknown; json(body: unknown): unknown } = {
        status(code: number) { Reply.statusCode = code; return Reply; },
        json(body: unknown) { Reply.body = body; return Reply; }
    };
    return Reply;
}

test("CONSENT_REQUIRED defaults on with MongoDB, off with SQLite, and an explicit value wins", () => {
    assert.equal(ConsentRequiredAtSignUp(MONGO), true);
    assert.equal(ConsentRequiredAtSignUp({} as NodeJS.ProcessEnv), true, "unset provider is MongoDB");
    assert.equal(ConsentRequiredAtSignUp(SQLITE), false, "a local server defaults to its own rules");
    assert.equal(ConsentRequiredAtSignUp({ ...SQLITE, MYSTICPARADOX_CONSENT_REQUIRED: "on" } as NodeJS.ProcessEnv), true);
    assert.equal(ConsentRequiredAtSignUp({ ...MONGO, MYSTICPARADOX_CONSENT_REQUIRED: "off" } as NodeJS.ProcessEnv), false);
    assert.equal(ConsentRequiredAtSignUp({ ...SQLITE, MYSTICPARADOX_CONSENT_REQUIRED: "false" } as NodeJS.ProcessEnv), false);
    assert.equal(ConsentRequiredAtSignUp({ ...SQLITE, MYSTICPARADOX_CONSENT_REQUIRED: "   " } as NodeJS.ProcessEnv), false, "a blank value is unset");
});

test("MYSTICPARADOX_CONSENT_ENFORCE is off unless set to on", () => {
    assert.equal(ConsentEnforced({} as NodeJS.ProcessEnv), false);
    assert.equal(ConsentEnforced({ MYSTICPARADOX_CONSENT_ENFORCE: "off" } as NodeJS.ProcessEnv), false);
    assert.equal(ConsentEnforced({ MYSTICPARADOX_CONSENT_ENFORCE: "ON" } as NodeJS.ProcessEnv), true);
});

test("a consent is current only for the current versions with the age confirmed", () => {
    assert.equal(IsConsentCurrent(undefined), false);
    assert.equal(IsConsentCurrent(CONSENT), true);
    assert.equal(IsConsentCurrent({ ...CONSENT, termsVersion: "2026-01-01" }), false);
    assert.equal(IsConsentCurrent({ ...CONSENT, privacyVersion: "2026-01-01" }), false);
    assert.equal(IsConsentCurrent({ ...CONSENT, ageConfirmed: false as unknown as true }), false);
});

test("registration without a consent is refused with 400 CONSENT_REQUIRED while consent is required", () => {
    const Refused = RefusalOf(() => ValidateRegistrationConsent(undefined, NOW, MONGO));
    assert.equal(Refused.code, "CONSENT_REQUIRED");
    assert.match(Refused.message, /Update the launcher/);
    assert.equal(ValidateRegistrationConsent(undefined, NOW, SQLITE), undefined, "not required with SQLite: nothing is recorded");
    assert.equal(ValidateRegistrationConsent(null, NOW, SQLITE), undefined);
});

test("a registration consent must confirm the age; outdated versions are refused only while consent is required", () => {
    assert.equal(RefusalOf(() => ValidateRegistrationConsent({ ...CONSENT, ageConfirmed: false }, NOW, SQLITE)).code, "CONSENT_AGE_REQUIRED");
    assert.equal(RefusalOf(() => ValidateRegistrationConsent({ ...CONSENT, ageConfirmed: "yes" }, NOW, MONGO)).code, "CONSENT_AGE_REQUIRED");
    assert.equal(RefusalOf(() => ValidateRegistrationConsent({ ...CONSENT, termsVersion: "2026-01-01" }, NOW, MONGO)).code, "CONSENT_REQUIRED");
    assert.equal(ValidateRegistrationConsent({ ...CONSENT, termsVersion: "2026-01-01" }, NOW, SQLITE), undefined);
});

test("a current registration consent is recorded with its time", () => {
    assert.deepEqual(ValidateRegistrationConsent(CONSENT, NOW, MONGO), { termsVersion: CURRENT.termsVersion, privacyVersion: CURRENT.privacyVersion, ageConfirmed: true, acceptedAt: NOW });
});

test("a deactivated account is refused with ACCOUNT_DEACTIVATED and the scheduled erasure time", () => {
    assert.doesNotThrow(() => AssertAccountNotDeactivated(Account()));
    const Refused = RefusalOf(() => AssertAccountNotDeactivated(Account({
        deletion: { requestedAt: NOW, scheduledFor: "2026-11-13T12:00:00.000Z" }
    })));
    assert.equal(Refused.code, "ACCOUNT_DEACTIVATED");
    assert.deepEqual(Refused.details, { scheduledFor: "2026-11-13T12:00:00.000Z" });
});

test("with MYSTICPARADOX_CONSENT_ENFORCE on, an account without a current consent gets 403 CONSENT_REQUIRED", () => {
    const Enforced = { ...MONGO, MYSTICPARADOX_CONSENT_ENFORCE: "on" } as NodeJS.ProcessEnv;
    assert.doesNotThrow(() => AssertConsentCurrentWhenEnforced(Account(), MONGO), "off by default");
    const Refused = RefusalOf(() => AssertConsentCurrentWhenEnforced(Account(), Enforced));
    assert.equal(Refused.code, "CONSENT_REQUIRED");
    assert.equal(Refused.status, 403);
    assert.doesNotThrow(() => AssertConsentCurrentWhenEnforced(Account({ consent: CONSENT }), Enforced));
});

test("SendLauncherError uses the status override and details, and keeps the fixed fields", () => {
    const Res = FakeResponse();
    SendLauncherError(Res as unknown as Response, new LauncherApiError("ACCOUNT_DEACTIVATED", "Deactivated.", { details: { scheduledFor: NOW, code: "spoof" } }));
    assert.equal(Res.statusCode, 403);
    assert.equal(Res.body.error.code, "ACCOUNT_DEACTIVATED");
    assert.equal(Res.body.error.message, "Deactivated.");
    assert.equal(Res.body.error.scheduledFor, NOW);
    assert.equal(typeof Res.body.error.requestId, "string");

    const Consent = FakeResponse();
    SendLauncherError(Consent as unknown as Response, new LauncherApiError("CONSENT_REQUIRED", "Update.", { status: 403 }));
    assert.equal(Consent.statusCode, 403);
    const Sign = FakeResponse();
    SendLauncherError(Sign as unknown as Response, new LauncherApiError("CONSENT_REQUIRED", "Update."));
    assert.equal(Sign.statusCode, 400, "the code's default status when no override is given");
});
