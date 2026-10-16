import assert from "node:assert/strict";
import test, { after } from "node:test";
import { LauncherAccountRecord, UsePersistenceForTest } from "../persistence";
import { OpenTestRealm, TestRealm } from "../persistence/sqlite/testSupport";
import { PRIVACY_VERSION, TERMS_VERSION } from "../legal/legalPolicy";
import { LauncherApiError } from "../security/launcherErrors";
import { USERNAME_NOT_ALLOWED_MESSAGE, USERNAME_RESERVED_MESSAGE } from "../security/usernamePolicy";
import { CheckUsernameAvailable, RegisterAccount, SetUsername } from "./launcherAuth";

// [2026-10-16] The username policy (security/usernamePolicy.ts, tested there) and uniqueness in any letter case, through the live check,
// registration and setting a name. Runs on a SQLite realm.

const Cleanups: Array<() => Promise<void>> = [];
after(async () => { for (const Cleanup of Cleanups) await Cleanup(); });

const TestConsent = { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, ageConfirmed: true };
let ipCounter = 0;
const NextIp = () => `198.51.100.${++ipCounter}`;

const Environment: Record<string, string | undefined> = {
    PERSISTENCE_PROVIDER: "sqlite", MYSTICPARADOX_REGISTRATION_APPROVAL: "off", MYSTICPARADOX_EMAIL_VERIFICATION: undefined
};

async function WithEnvironment<T>(run: () => Promise<T>): Promise<T> {
    const Saved = new Map<string, string | undefined>();
    for (const [Key, Value] of Object.entries(Environment)) {
        Saved.set(Key, process.env[Key]);
        if (Value === undefined) delete process.env[Key];
        else process.env[Key] = Value;
    }
    try {
        return await run();
    } finally {
        for (const [Key, Value] of Saved) {
            if (Value === undefined) delete process.env[Key];
            else process.env[Key] = Value;
        }
    }
}

function Realm(label: string): TestRealm {
    const Opened = OpenTestRealm(label);
    Cleanups.push(Opened.cleanup);
    UsePersistenceForTest({ repos: Opened.repos, uow: Opened.uow });
    return Opened;
}

function Register(name: string | undefined, label: string) {
    return WithEnvironment(() =>
        RegisterAccount(name, `${label.toLowerCase()}@example.test`, "correct horse battery", "Test PC", `device-${label}`, NextIp(), TestConsent));
}

async function Refusal(run: () => Promise<unknown>): Promise<LauncherApiError> {
    try {
        await run();
    } catch (error) {
        if (error instanceof LauncherApiError) return error;
        throw error;
    }
    assert.fail("expected a refusal");
}

test("[2026-10-16] the live check: free, taken in another case, invalid and reserved, each with its reason", async () => {
    Realm("username-check");
    await Register("SlayerOne", "CheckOne");

    assert.deepEqual(await CheckUsernameAvailable("SlayerTwo"), { available: true });
    assert.deepEqual(await CheckUsernameAvailable("SLAYERONE"), { available: false, reason: "That username is already taken." });
    assert.match((await CheckUsernameAvailable("Slayer_One")).reason ?? "", /only contain letters and numbers/);
    assert.match((await CheckUsernameAvailable("4242")).reason ?? "", /at least one letter/);
    assert.equal((await CheckUsernameAvailable("Admin7")).reason, USERNAME_RESERVED_MESSAGE);
    assert.equal((await CheckUsernameAvailable("Sh1tLord")).reason, USERNAME_NOT_ALLOWED_MESSAGE);
});

test("[2026-10-16] registration refuses a taken, reserved or invalid name, and keeps the name optional for launchers 0.1.67-0.1.70", async () => {
    const Opened = Realm("username-register");
    const First = await Register("EmberHold", "RegOne");
    assert.equal(First.account.displayName, "EmberHold");
    assert.equal(First.account.needsUsername, false);

    assert.equal((await Refusal(() => Register("emberhold", "RegTwo"))).code, "AUTH_DISPLAY_NAME_TAKEN");
    assert.equal((await Refusal(() => Register("MysticParadox", "RegThree"))).code, "AUTH_VALIDATION_FAILED");
    assert.equal((await Refusal(() => Register("Ember_Hold", "RegFour"))).code, "AUTH_VALIDATION_FAILED");

    const Nameless = await Register(undefined, "RegFive");
    assert.equal(Nameless.account.needsUsername, true);
    const Stored = await Opened.repos.launcherAccounts.findByUserId(Nameless.account.userId) as LauncherAccountRecord;
    assert.equal(Stored.usernameSet, false);
});

test("[2026-10-16] setting a name: someone else's (any case) and reserved names are refused; your own name is kept", async () => {
    const Opened = Realm("username-set");
    const Taken = await Register("QuietFox", "SetOne");
    const Nameless = await Register(undefined, "SetTwo");

    assert.equal((await Refusal(() => SetUsername(Nameless.account.userId, "QUIETFOX"))).code, "AUTH_DISPLAY_NAME_TAKEN");
    assert.equal((await Refusal(() => SetUsername(Nameless.account.userId, "staff1"))).code, "AUTH_VALIDATION_FAILED");

    const Named = await SetUsername(Nameless.account.userId, "BrannOak");
    assert.equal(Named.displayName, "BrannOak");
    assert.equal(Named.needsUsername, false);
    assert.equal((await SetUsername(Taken.account.userId, "quietFOX")).displayName, "quietFOX", "a new letter case of your own name");

    // An account that already holds a name on the reserved list (set before the list existed) keeps it.
    const Legacy = await Register(undefined, "SetThree");
    await Opened.repos.launcherAccounts.setUsername(Legacy.account.userId, "Support", "support");
    assert.equal((await SetUsername(Legacy.account.userId, "Support")).displayName, "Support");
});
