/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

"use strict";

// [2026-10-14 M1] A digest of every hunt manifest the tables produce, for the parity tests of the Director and the
// Metagame. The clock and the random choice are pinned, so the same tables always give the same lines. golden-digest.json
// holds the digest the Director's own resolver produced before the move into shared/hunt-manifest; both components'
// tests must reproduce it. Nothing here contains game data: the digest is a hash, and the lines stay in memory.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PINNED_NOW_MS = 1800000000000;
// "first" makes every random pick return its lowest candidate, "last" its highest.
const PINNED_CHOICES = Object.freeze(["first", "last"]);
const EXPECTED_SETS = Object.freeze([["acc-1"], ["acc-1", "acc-2", "acc-3", "acc-4"]]);
const INVALID_EXPECTED_SETS = Object.freeze([[], ["acc-1", "acc-2", "acc-3", "acc-4", "acc-5"], [""], ["acc-1", 7], null, "acc-1"]);
const UNKNOWN_HUNT_IDS = Object.freeze(["__digest_unknown_hunt__", "", " ", "ShatteredIsles_IslandA "]);

/** Runs fn with Date.now and crypto.randomInt pinned, then restores them (also when fn throws). */
function WithPinnedClockAndRandom(choice, fn) {
    const RealNow = Date.now;
    const RealRandomInt = crypto.randomInt;
    Date.now = () => PINNED_NOW_MS;
    crypto.randomInt = (min, max) => (choice === "first" ? min : max - 1);
    try {
        return fn();
    } finally {
        Date.now = RealNow;
        crypto.randomInt = RealRandomInt;
    }
}

function Outcome(fn) {
    try {
        return JSON.stringify(fn());
    } catch (error) {
        return "ERR " + (error && error.message);
    }
}

/**
 * One line per (choice, hunt, expected set) for both the plain and the player-hosted manifest, then the unknown ids and
 * the invalid expected-player lists. resolvePlain and resolveHosted take (huntId, expectedPlayers) and return a manifest
 * or throw.
 */
function BuildManifestDump(playerHuntIds, resolvePlain, resolveHosted) {
    const Lines = [];
    for (const Choice of PINNED_CHOICES) {
        WithPinnedClockAndRandom(Choice, () => {
            for (const HuntId of playerHuntIds) {
                for (const Expected of EXPECTED_SETS) {
                    const Key = `${Choice}|${HuntId}|${JSON.stringify(Expected)}`;
                    Lines.push(`plain|${Key}|${Outcome(() => resolvePlain(HuntId, Expected))}`);
                    Lines.push(`hosted|${Key}|${Outcome(() => resolveHosted(HuntId, Expected))}`);
                }
            }
            for (const HuntId of UNKNOWN_HUNT_IDS) {
                const Key = `${Choice}|${JSON.stringify(HuntId)}|${JSON.stringify(["acc-1"])}`;
                Lines.push(`plain|${Key}|${Outcome(() => resolvePlain(HuntId, ["acc-1"]))}`);
                Lines.push(`hosted|${Key}|${Outcome(() => resolveHosted(HuntId, ["acc-1"]))}`);
            }
            const Probe = playerHuntIds[0];
            for (const Expected of INVALID_EXPECTED_SETS) {
                const Key = `${Choice}|${Probe}|${JSON.stringify(Expected)}`;
                Lines.push(`plain|${Key}|${Outcome(() => resolvePlain(Probe, Expected))}`);
                Lines.push(`hosted|${Key}|${Outcome(() => resolveHosted(Probe, Expected))}`);
            }
        });
    }
    return Lines;
}

function DigestOf(lines) {
    return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** The committed digest (golden-digest.json next to this file). */
function ReadGoldenDigest() {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "golden-digest.json"), "utf8"));
}

module.exports = { PINNED_NOW_MS, WithPinnedClockAndRandom, BuildManifestDump, DigestOf, ReadGoldenDigest };
