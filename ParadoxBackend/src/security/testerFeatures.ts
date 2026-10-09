/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Roles the admin dashboard is allowed to grant/revoke via PATCH /admin/v1/players/:userId/roles.
// "player" and "admin" are assigned elsewhere (registration, bootstrap script) and are
// intentionally excluded so this endpoint can't be used to self-promote or demote admins.
export const ASSIGNABLE_ROLES: readonly string[] = ["tester"];

export const TESTER_ROLE = "tester";

// Server-side allow-list: the ONLY place a logical feature id maps to the exe-relative
// .flag filename the runtime DLL checks (MpExeRelativeFlagPresent). The admin dashboard and
// launcher only ever see the ids on the left; the launcher's Rust flag reconciler must keep
// an identical id->filename table and never accept a filename or path from the server.
//
// Deliberately just one entry. Every flag in the DLL was originally A/B-tested for a specific
// debugging session, not vetted as "safe to hand every tester automatically" — an earlier
// draft of this table included NATIVE_NET_TICK.flag by copying names out of a source grep
// without checking what they do. Progress/02_NETWORK_REPLICATION.md documents that flag was
// tested and made the server UNJOINABLE ("DEAD END — do not promote it"), and it's a
// server-side flag read next to the *game* exe, so it would also apply if a tester ran their
// own dedicated Ramsgate/Training Dojo server. Before adding anything else here, check
// Progress/02_NETWORK_REPLICATION.md and Progress/25_DLL_RELEASE_CLEANUP.md for that flag's
// history — most are fine (pure extra logging, e.g. REPGRAPH_DIAG/TEMPEST_CHARGE_DIAG/
// TRIALS_GRACE_DIAG), but at least one is not, and blanket-granting "every known flag" to
// every tester is exactly how that happens again.
export const TESTER_MANAGED_FEATURES: Record<string, string> = {
    "diagnostics.verbose": "VERBOSE_DIAG.flag"
};
