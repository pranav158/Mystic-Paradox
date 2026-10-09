/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

/** Semantic-version comparison with prerelease precedence; unparseable versions never pass. */
export function VersionAtLeast(actual: string, minimum: string): boolean {
    const parse = (value: string) => {
        const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
        if (match == undefined) return undefined;
        try {
            return {
                core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])] as const,
                prerelease: match[4]?.split(".")
            };
        } catch { return undefined; }
    };
    const left = parse(actual);
    const right = parse(minimum);
    if (left == undefined || right == undefined) return false;
    for (let index = 0; index < 3; index += 1) {
        if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index];
    }
    if (left.prerelease == undefined) return true;
    if (right.prerelease == undefined) return false;
    const count = Math.max(left.prerelease.length, right.prerelease.length);
    for (let index = 0; index < count; index += 1) {
        const a = left.prerelease[index]; const b = right.prerelease[index];
        if (a == undefined) return true;
        if (b == undefined) return false;
        if (a === b) continue;
        const aNumeric = /^\d+$/.test(a); const bNumeric = /^\d+$/.test(b);
        if (aNumeric && bNumeric) return BigInt(a) > BigInt(b);
        if (aNumeric !== bNumeric) return !aNumeric;
        return a > b;
    }
    return true;
}
