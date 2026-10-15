/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DecideHuntRoute, IsP2PTrainingRequest, P2PRolloutBucket, ReadP2PPolicy } from "./p2pPolicy";

const BaseInput = {
    gameMode: "ISLAND",
    huntId: "ShatteredIsles_IslandA",
    accountIds: ["player-a", "player-b"],
    partySize: 2,
    isPrivateParty: true
} as const;

test("P2P policy fails closed when all environment values are absent", () => {
    const Policy = ReadP2PPolicy({});
    assert.equal(Policy.enabled, false);
    assert.equal(Policy.allowedAccounts.size, 0);
    assert.equal(Policy.allowAllAccounts, false);
    assert.equal(Policy.allowedHunts.size, 0);
    assert.equal(Policy.allowAllResolvableHunts, false);
    assert.equal(Policy.allowHighRiskHuntClasses, false);
    assert.equal(Policy.privatePartiesOnly, true);
    assert.equal(Policy.maxPartySize, 4);
    assert.equal(Policy.percentRollout, 0);
    assert.equal(Policy.forceSdr, false);
    assert.equal(Policy.canaryEnabled, false);
    assert.equal(Policy.trustTier, 0);
    assert.equal(Policy.tier1RewardsEnabled, false);
    assert.equal(Policy.tier1ShadowApproved, false);
    // [2026-10-15] No DeployServer in this environment: there is no dedicated route to take.
    assert.equal(Policy.dedicatedHuntsDisabled, true);
    assert.deepEqual(
        DecideHuntRoute(BaseInput, Policy, { playerHostedImplemented: false }),
        { route: "DEDICATED", reason: "FEATURE_DISABLED", rolloutBucket: null }
    );
});

test("only literal true enables the master feature flag", () => {
    for (const Value of ["1", "yes", "on", "TRUE-ish"]) {
        assert.equal(ReadP2PPolicy({ P2P_HUNTS_ENABLED: Value }).enabled, false);
    }
    assert.equal(ReadP2PPolicy({ P2P_HUNTS_ENABLED: "true" }).enabled, true);
    assert.equal(ReadP2PPolicy({ P2P_HUNTS_ENABLED: " TRUE " }).enabled, true);
});

test("durable emergency stop has a distinct reason without mutating environment policy", () => {
    const Policy = ReadP2PPolicy({
        P2P_HUNTS_ENABLED: "true",
        P2P_ALLOWED_ACCOUNTS: "player-a,player-b",
        P2P_ALLOWED_HUNTS: "ShatteredIsles_IslandA",
        P2P_PERCENT_ROLLOUT: "100",
        P2P_TIER0_CANARY_ENABLED: "true"
    });
    assert.equal(Policy.enabled, true);
    assert.deepEqual(
        DecideHuntRoute(BaseInput, Policy, { playerHostedImplemented: true, emergencyStop: true }),
        { route: "DEDICATED", reason: "P2P_EMERGENCY_STOP", rolloutBucket: null }
    );
    assert.equal(DecideHuntRoute(BaseInput, Policy, { playerHostedImplemented: true }).route, "PLAYER_HOSTED");
});

test("enabled policy still requires explicit account and hunt allowlists", () => {
    const Empty = ReadP2PPolicy({ P2P_HUNTS_ENABLED: "true", P2P_PERCENT_ROLLOUT: "100" });
    assert.equal(DecideHuntRoute(BaseInput, Empty, { playerHostedImplemented: true }).reason, "ACCOUNT_ALLOWLIST_EMPTY");

    const AccountOnly = ReadP2PPolicy({
        P2P_HUNTS_ENABLED: "true",
        P2P_PERCENT_ROLLOUT: "100",
        P2P_TIER0_CANARY_ENABLED: "true",
        P2P_ALLOWED_ACCOUNTS: "player-a,player-b"
    });
    assert.equal(DecideHuntRoute(BaseInput, AccountOnly, { playerHostedImplemented: true }).reason, "HUNT_ALLOWLIST_EMPTY");
});

test("Phase 0 capability gate keeps a fully allowlisted hunt dedicated", () => {
    const Policy = ReadP2PPolicy({
        P2P_HUNTS_ENABLED: "true",
        P2P_ALLOWED_ACCOUNTS: "player-a, player-b",
        P2P_ALLOWED_HUNTS: "ShatteredIsles_IslandA",
        P2P_PERCENT_ROLLOUT: "100",
        P2P_TIER0_CANARY_ENABLED: "true",
        P2P_FORCE_SDR: "true"
    });
    const Decision = DecideHuntRoute(BaseInput, Policy, { playerHostedImplemented: false });
    assert.equal(Decision.route, "DEDICATED");
    assert.equal(Decision.reason, "PLAYER_HOSTED_NOT_IMPLEMENTED");
    assert.equal(typeof Decision.rolloutBucket, "number");
});

test("future capability can select player hosting only after every gate passes", () => {
    const Policy = ReadP2PPolicy({
        P2P_HUNTS_ENABLED: "true",
        P2P_ALLOWED_ACCOUNTS: "player-a,player-b",
        P2P_ALLOWED_HUNTS: "ShatteredIsles_IslandA",
        P2P_PERCENT_ROLLOUT: "100",
        P2P_TIER0_CANARY_ENABLED: "true"
    });
    assert.deepEqual(
        DecideHuntRoute(BaseInput, Policy, { playerHostedImplemented: true }).route,
        "PLAYER_HOSTED"
    );
    assert.equal(
        DecideHuntRoute({ ...BaseInput, gameMode: "SHARED" }, Policy, { playerHostedImplemented: true }).route,
        "PLAYER_HOSTED"
    );
    assert.equal(
        DecideHuntRoute({ ...BaseInput, gameMode: "CITY" }, Policy, { playerHostedImplemented: true }).reason,
        "NOT_A_PLAYER_HOSTED_HUNT"
    );
});

test("private-party, party-size, account, and hunt gates fail independently", () => {
    const Policy = ReadP2PPolicy({
        P2P_HUNTS_ENABLED: "true",
        P2P_ALLOWED_ACCOUNTS: "player-a,player-b",
        P2P_ALLOWED_HUNTS: "ShatteredIsles_IslandA",
        P2P_PERCENT_ROLLOUT: "100",
        P2P_MAX_PARTY_SIZE: "2",
        P2P_TIER0_CANARY_ENABLED: "true"
    });
    assert.equal(DecideHuntRoute({ ...BaseInput, isPrivateParty: false }, Policy, { playerHostedImplemented: true }).reason, "PRIVATE_PARTY_REQUIRED");
    assert.equal(DecideHuntRoute({ ...BaseInput, partySize: 3 }, Policy, { playerHostedImplemented: true }).reason, "PARTY_SIZE_EXCEEDED");
    assert.equal(DecideHuntRoute({ ...BaseInput, accountIds: ["player-a", "stranger"] }, Policy, { playerHostedImplemented: true }).reason, "ACCOUNT_NOT_ALLOWLISTED");
    assert.equal(DecideHuntRoute({ ...BaseInput, huntId: "OtherHunt" }, Policy, { playerHostedImplemented: true }).reason, "HUNT_NOT_ALLOWLISTED");
});

test("rollout bucket is stable across roster ordering and bounded below 100", () => {
    const First = P2PRolloutBucket(["player-b", "player-a"], "hunt");
    const Second = P2PRolloutBucket(["player-a", "player-b", "player-a"], "hunt");
    assert.equal(First, Second);
    assert.ok(First >= 0 && First < 100);
});

test("invalid numeric policy values fail closed", () => {
    const Policy = ReadP2PPolicy({
        P2P_MAX_PARTY_SIZE: "99",
        P2P_PERCENT_ROLLOUT: "NaN"
    });
    assert.equal(Policy.maxPartySize, 4);
    assert.equal(Policy.percentRollout, 0);
});

test("player hosting needs a separate explicit Tier 0 canary switch", () => {
    const Policy = ReadP2PPolicy({
        P2P_HUNTS_ENABLED: "true",
        P2P_ALLOWED_ACCOUNTS: "player-a,player-b",
        P2P_ALLOWED_HUNTS: "ShatteredIsles_IslandA",
        P2P_PERCENT_ROLLOUT: "100"
    });
    assert.equal(DecideHuntRoute(BaseInput, Policy, { playerHostedImplemented: true }).reason, "CANARY_DISABLED");
});

test("trust tier defaults to zero and recognizes only explicit tier one", () => {
    assert.equal(ReadP2PPolicy({ P2P_TRUST_TIER: "2" }).trustTier, 0);
    assert.equal(ReadP2PPolicy({ P2P_TRUST_TIER: "garbage" }).trustTier, 0);
    assert.equal(ReadP2PPolicy({ P2P_TRUST_TIER: "1" }).trustTier, 1);
});

test("competitive and high-risk hunt classes stay dedicated even when allowlisted", () => {
    const Policy = ReadP2PPolicy({
        P2P_HUNTS_ENABLED: "true",
        P2P_TIER0_CANARY_ENABLED: "true",
        P2P_ALLOWED_ACCOUNTS: "player-a,player-b",
        P2P_ALLOWED_HUNTS: "Trials_Leaderboard",
        P2P_PERCENT_ROLLOUT: "100"
    });
    assert.equal(DecideHuntRoute({ ...BaseInput, huntId: "Trials_Leaderboard" }, Policy,
        { playerHostedImplemented: true }).reason, "HUNT_CLASS_EXCLUDED");
});

test("all-resolvable rollout still requires explicit accounts and capability gates", () => {
    const Policy = ReadP2PPolicy({
        P2P_HUNTS_ENABLED: "true",
        P2P_TIER0_CANARY_ENABLED: "true",
        P2P_ALLOWED_ACCOUNTS: "player-a,player-b",
        P2P_ALLOW_ALL_RESOLVABLE_HUNTS: "true",
        P2P_PERCENT_ROLLOUT: "100"
    });
    assert.equal(Policy.allowedHunts.size, 0);
    assert.equal(DecideHuntRoute({ ...BaseInput, huntId: "ShatteredIsles_IslandU" }, Policy,
        { playerHostedImplemented: true }).route, "PLAYER_HOSTED");
    assert.equal(DecideHuntRoute({ ...BaseInput, accountIds: ["player-a", "stranger"] }, Policy,
        { playerHostedImplemented: true }).reason, "ACCOUNT_NOT_ALLOWLISTED");
    assert.equal(DecideHuntRoute(BaseInput, Policy,
        { playerHostedImplemented: false }).reason, "PLAYER_HOSTED_NOT_IMPLEMENTED");
});

test("automatic primary rollout can explicitly admit all accounts", () => {
    const Policy = ReadP2PPolicy({
        P2P_HUNTS_ENABLED: "true",
        P2P_TIER0_CANARY_ENABLED: "true",
        P2P_ALLOW_ALL_ACCOUNTS: "true",
        P2P_ALLOW_ALL_RESOLVABLE_HUNTS: "true",
        P2P_PERCENT_ROLLOUT: "100"
    });
    assert.equal(Policy.allowAllAccounts, true);
    assert.equal(DecideHuntRoute({ ...BaseInput, accountIds: ["new-player", "other-player"] }, Policy,
        { playerHostedImplemented: true }).route, "PLAYER_HOSTED");
});

test("dedicated hunt disable rail recognizes only literal true", () => {
    // [2026-10-15] With a DeployServer configured, the rail alone decides.
    const WithDeployServer = { DEPLOYSERVER_URL: "deployserver.invalid:8080" };
    for (const Value of [undefined, "1", "yes", "on", "TRUE-ish"]) {
        assert.equal(ReadP2PPolicy({ ...WithDeployServer, P2P_DISABLE_DEDICATED_HUNTS: Value }).dedicatedHuntsDisabled, false);
    }
    assert.equal(ReadP2PPolicy({ ...WithDeployServer, P2P_DISABLE_DEDICATED_HUNTS: " true " }).dedicatedHuntsDisabled, true);
});

test("no DeployServer (DEPLOYSERVER_URL unset or blank) disables the dedicated route whatever the rail says (2026-10-15)", () => {
    const Unconfigured: NodeJS.ProcessEnv[] = [{}, { DEPLOYSERVER_URL: "" }, { DEPLOYSERVER_URL: "   " }];
    for (const Environment of Unconfigured) {
        assert.equal(ReadP2PPolicy(Environment).dedicatedHuntsDisabled, true, JSON.stringify(Environment));
        assert.equal(ReadP2PPolicy({ ...Environment, P2P_DISABLE_DEDICATED_HUNTS: "false" }).dedicatedHuntsDisabled, true);
    }
    assert.equal(ReadP2PPolicy({ DEPLOYSERVER_URL: "deployserver.invalid:8080" }).dedicatedHuntsDisabled, false);
});

test("high-risk classes require a second explicit switch", () => {
    const BaseEnvironment = {
        P2P_HUNTS_ENABLED: "true",
        P2P_TIER0_CANARY_ENABLED: "true",
        P2P_ALLOWED_ACCOUNTS: "player-a,player-b",
        P2P_ALLOW_ALL_RESOLVABLE_HUNTS: "true",
        P2P_PERCENT_ROLLOUT: "100"
    };
    const TrialsInput = { ...BaseInput, huntId: "CR19_PlayerHunt_Arena_Hard" };
    assert.equal(DecideHuntRoute(TrialsInput, ReadP2PPolicy(BaseEnvironment),
        { playerHostedImplemented: true }).reason, "HUNT_CLASS_EXCLUDED");
    assert.equal(DecideHuntRoute(TrialsInput, ReadP2PPolicy({
        ...BaseEnvironment,
        P2P_ALLOW_HIGH_RISK_HUNT_CLASSES: "true"
    }), { playerHostedImplemented: true }).route, "PLAYER_HOSTED");
});

test("known FTUE recursion stays excluded even during the broad rollout", () => {
    const Policy = ReadP2PPolicy({
        P2P_HUNTS_ENABLED: "true",
        P2P_TIER0_CANARY_ENABLED: "true",
        P2P_ALLOWED_ACCOUNTS: "player-a,player-b",
        P2P_ALLOW_ALL_RESOLVABLE_HUNTS: "true",
        P2P_ALLOW_HIGH_RISK_HUNT_CLASSES: "true",
        P2P_PERCENT_ROLLOUT: "100"
    });
    assert.equal(DecideHuntRoute({ ...BaseInput, huntId: "CR19_PlayerHunt_FTUE_Pursuit_Beta_Beaver" },
        Policy, { playerHostedImplemented: true }).reason, "HUNT_RUNTIME_INCOMPATIBLE");
});

test("Tier 1 requires separate reward, shadow, account, and hunt gates", () => {
    const base = {
        P2P_HUNTS_ENABLED: "true", P2P_TIER0_CANARY_ENABLED: "true", P2P_TRUST_TIER: "1",
        P2P_ALLOWED_ACCOUNTS: "player-a,player-b", P2P_ALLOWED_HUNTS: "ShatteredIsles_IslandA",
        P2P_PERCENT_ROLLOUT: "100"
    };
    assert.equal(DecideHuntRoute(BaseInput, ReadP2PPolicy(base), { playerHostedImplemented: true }).reason,
        "TIER1_REWARDS_DISABLED");
    assert.equal(DecideHuntRoute(BaseInput, ReadP2PPolicy({ ...base, P2P_TIER1_REWARDS_ENABLED: "true" }),
        { playerHostedImplemented: true }).reason, "TIER1_SHADOW_NOT_APPROVED");
    const shadow = { ...base, P2P_TIER1_REWARDS_ENABLED: "true", P2P_TIER1_SHADOW_APPROVED: "true" };
    assert.equal(DecideHuntRoute(BaseInput, ReadP2PPolicy(shadow), { playerHostedImplemented: true }).reason,
        "TIER1_ACCOUNT_NOT_ALLOWLISTED");
    const accounts = { ...shadow, P2P_TIER1_ALLOWED_ACCOUNTS: "player-a,player-b" };
    assert.equal(DecideHuntRoute(BaseInput, ReadP2PPolicy(accounts), { playerHostedImplemented: true }).reason,
        "TIER1_HUNT_NOT_ALLOWLISTED");
    const complete = { ...accounts, P2P_TIER1_ALLOWED_HUNTS: "ShatteredIsles_IslandA" };
    assert.equal(DecideHuntRoute(BaseInput, ReadP2PPolicy(complete), { playerHostedImplemented: true }).route,
        "PLAYER_HOSTED");
});

test("Training Grounds stay dedicated unless P2P_TRAINING_ENABLED is literally true (B7, 2026-10-11)", () => {
    const BaseEnvironment = {
        P2P_HUNTS_ENABLED: "true",
        P2P_TIER0_CANARY_ENABLED: "true",
        P2P_ALLOWED_ACCOUNTS: "player-a,player-b",
        P2P_ALLOW_ALL_RESOLVABLE_HUNTS: "true",
        P2P_PERCENT_ROLLOUT: "100"
    };
    const TrainingInput = { ...BaseInput, gameMode: "SHARED", huntId: "ShatteredIsles_TrainingDojo" };
    assert.equal(ReadP2PPolicy({}).trainingEnabled, false);
    for (const Value of [undefined, "1", "yes", "on"]) {
        const Policy = ReadP2PPolicy({ ...BaseEnvironment, P2P_TRAINING_ENABLED: Value });
        assert.equal(Policy.trainingEnabled, false);
        assert.equal(DecideHuntRoute(TrainingInput, Policy, { playerHostedImplemented: true }).reason, "NOT_A_PLAYER_HOSTED_HUNT");
        assert.equal(IsP2PTrainingRequest("SHARED", "ShatteredIsles_TrainingDojo", Policy), false);
    }
    const Enabled = ReadP2PPolicy({ ...BaseEnvironment, P2P_TRAINING_ENABLED: "true" });
    assert.equal(DecideHuntRoute(TrainingInput, Enabled, { playerHostedImplemented: true }).route, "PLAYER_HOSTED");
    assert.equal(IsP2PTrainingRequest("SHARED", "ShatteredIsles_TrainingDojo", Enabled), true);
    // Only the SHARED request the client sends; Ramsgate never.
    assert.equal(DecideHuntRoute({ ...TrainingInput, gameMode: "ISLAND" }, Enabled, { playerHostedImplemented: true }).reason,
        "NOT_A_PLAYER_HOSTED_HUNT");
    assert.equal(DecideHuntRoute({ ...TrainingInput, huntId: "ShatteredIsles_ReturnToRamsgate" }, Enabled,
        { playerHostedImplemented: true }).reason, "NOT_A_PLAYER_HOSTED_HUNT");
    assert.equal(IsP2PTrainingRequest("SHARED", "ShatteredIsles_IslandA", Enabled), false);
    // The master switch still wins.
    assert.equal(IsP2PTrainingRequest("SHARED", "ShatteredIsles_TrainingDojo",
        ReadP2PPolicy({ ...BaseEnvironment, P2P_HUNTS_ENABLED: "false", P2P_TRAINING_ENABLED: "true" })), false);
    // The hunt allowlist still applies when the broad switch is off.
    const Allowlisted = ReadP2PPolicy({ ...BaseEnvironment, P2P_ALLOW_ALL_RESOLVABLE_HUNTS: "false",
        P2P_ALLOWED_HUNTS: "ShatteredIsles_IslandA", P2P_TRAINING_ENABLED: "true" });
    assert.equal(DecideHuntRoute(TrainingInput, Allowlisted, { playerHostedImplemented: true }).reason, "HUNT_NOT_ALLOWLISTED");
});
