import assert from "node:assert/strict";
import test from "node:test";
import { ParseSteamTransportId } from "./steamTransportIdentity";

test("accepts public individual SteamID64 transport identities", () => {
    assert.equal(ParseSteamTransportId("76561198000000102"), "76561198000000102");
    assert.equal(ParseSteamTransportId("76561197960265728"), "76561197960265728");
});

test("rejects malformed and non-individual Steam identifiers", () => {
    assert.equal(ParseSteamTransportId("480"), undefined);
    assert.equal(ParseSteamTransportId("7656119909130290x"), undefined);
    assert.equal(ParseSteamTransportId("76561197960265727"), undefined);
    assert.equal(ParseSteamTransportId(76561198000000102), undefined);
});
