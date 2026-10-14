import assert from "node:assert/strict";
import test from "node:test";
import { ValidateSteamId64 } from "./bind_p2p_steam_account";

test("accepts the valid individual SteamID64 account range", () => {
    assert.equal(ValidateSteamId64("76561197960265728"), true);
    assert.equal(ValidateSteamId64("76561202255233023"), true);
});

test("rejects malformed and out-of-range Steam identifiers", () => {
    assert.equal(ValidateSteamId64("480"), false);
    assert.equal(ValidateSteamId64("76561197960265727"), false);
    assert.equal(ValidateSteamId64("76561202255233024"), false);
    assert.equal(ValidateSteamId64("7656119796026572x"), false);
});
