import assert from "node:assert/strict";
import test from "node:test";
import { LauncherApiError } from "./launcherErrors";
import { AssertUsernameAllowed, USERNAME_NOT_ALLOWED_MESSAGE, USERNAME_RESERVED_MESSAGE, ValidateUsername } from "./usernamePolicy";

// [2026-10-16] The username policy: the format (letters and digits only, the owner's decision), staff/project impersonation, and
// vulgar, abusive or slur names - including digit and stretched spellings - without refusing ordinary names that contain such letters.

function Rejects(name: string): string {
    try {
        ValidateUsername(name);
    } catch (error) {
        assert.ok(error instanceof LauncherApiError);
        assert.equal(error.code, "AUTH_VALIDATION_FAILED");
        return error.message;
    }
    assert.fail(`${JSON.stringify(name)} was accepted`);
}

function Refusal(name: string, env: NodeJS.ProcessEnv = {}): string | undefined {
    try {
        AssertUsernameAllowed(name, env);
        return undefined;
    } catch (error) {
        assert.ok(error instanceof LauncherApiError);
        assert.equal(error.code, "AUTH_VALIDATION_FAILED");
        return error.message;
    }
}

test("[2026-10-16] format: letters and digits, 3-16 characters, at least one letter; underscores and every other symbol refused", () => {
    for (const name of ["Fox", "MysticFox", "Fox99", "x12", "Sixteen16Chars16"]) assert.equal(ValidateUsername(name), name);
    assert.equal(ValidateUsername("  MysticFox  "), "MysticFox");
    for (const name of ["Mystic_Fox", "fox!", "fox-x", "fox x", "fox.x", "fóx", "fox@home", "<b>fox"]) {
        assert.match(Rejects(name), /only contain letters and numbers/, name);
    }
    assert.match(Rejects("123"), /at least one letter/);
    assert.match(Rejects("ab"), /3–16 characters/);
    assert.match(Rejects("A".repeat(17)), /3–16 characters/);
});

test("[2026-10-16] staff and project names are reserved anywhere in a name; short reserved words only as the whole name", () => {
    for (const name of ["Admin", "AdminBob", "TheAdmin7", "Moderator", "ModeratorX", "TheOwner", "Owner1", "StaffFox", "Support",
        "FoxSupport", "Official", "Developer", "GameMaster", "MysticParadox", "MysticFox", "MysticFox2", "PhoenixLabs",
        "Mod", "mod7", "Dev", "GM", "Root", "Paradox", "Paradox99", "Dauntless", "Player1", "Host", "Guest", "Null"]) {
        assert.equal(Refusal(name), USERNAME_RESERVED_MESSAGE, name);
    }
});

test("[2026-10-16] vulgar, abusive and slur names are refused, also in digit and stretched spellings, without saying which part", () => {
    // The terms are assembled so the test itself reads plainly.
    const f = "fu" + "ck", s = "sh" + "it", n = "ni" + "gg";
    for (const name of [`${f}er`, `Big${s}`, `${n}a`, `${n}er7`, "Fuuuuck", "Shiiiit", "Sh1t", "B1tch", "N1gg4", "Pen15", "Wh0re",
        "S3xy", "Dick", "Dick69", "D1ck", "Cock", "Rape", "Nazi", "Hitler", "KKKfox", "Cum", "Tits", "Wanker", "Rapist", "Kys",
        "Killyourself", "Pussy", "Porn", "Faggot", "Retard", "Kike", "Coon"]) {
        assert.equal(Refusal(name), USERNAME_NOT_ALLOWED_MESSAGE, name);
    }
});

test("[2026-10-16] ordinary names that only contain such letters pass (the Scunthorpe guard)", () => {
    for (const name of ["Peacock", "Hancock", "Grapefruit", "Therapist", "Raccoon", "Torpedo", "Sussex", "Essex", "Sextant", "Skyshard",
        "Swanky", "Nazir", "VanDyke", "Kikeo", "Assassin", "Classic", "Cassandra", "Bassist", "Cumulus", "Analyst", "Dickens", "Titan",
        "Shiitake", "Night", "Nigel", "Niger", "Homer", "Assault", "Moderna", "ParadoxHunter", "Hostage", "Embermane", "Mysticzzz",
        "Tempest7", "QuietFox", "Kestrel", "Brimvane", "R4in", "Fox99", "Glass", "Scrapes", "Drape", "Spice", "Cockpit"]) {
        assert.equal(Refusal(name), undefined, name);
    }
});

test("[2026-10-16] the operator's MYSTICPARADOX_USERNAME_BLOCKLIST adds terms (case-insensitive); malformed entries are ignored", () => {
    const env = { MYSTICPARADOX_USERNAME_BLOCKLIST: "Grief, toxic  b@d x" };
    assert.equal(Refusal("GriefLord", env), USERNAME_NOT_ALLOWED_MESSAGE);
    assert.equal(Refusal("ToXiCfox", env), USERNAME_NOT_ALLOWED_MESSAGE);
    assert.equal(Refusal("Toxic7", env), USERNAME_NOT_ALLOWED_MESSAGE);
    assert.equal(Refusal("Badger", env), undefined, "b@d is not a valid term");
    assert.equal(Refusal("Xenon", env), undefined, "a 1-letter term is ignored");
    assert.equal(Refusal("GriefLord"), undefined, "without the key the name passes");
});
