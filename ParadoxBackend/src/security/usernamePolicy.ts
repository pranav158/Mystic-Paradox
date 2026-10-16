import { LauncherApiError } from "./launcherErrors";

// [2026-10-16] Launcher usernames: the in-game display name AND the realm invite handle. Letters and digits only (the owner's
// decision: no underscores or other symbols), 3-16 characters, at least one letter, unique in any letter case (checked by the
// caller against the accounts). A name must also not impersonate staff or the project and must not be vulgar, abusive or a slur.
// The word lists are a best-effort filter, not a guarantee: the operator can add terms with MYSTICPARADOX_USERNAME_BLOCKLIST and
// still moderate names by hand. They apply to new names only; an account keeps a name it already has.

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 16;
const USERNAME_PATTERN = /^[A-Za-z0-9]+$/;

export const USERNAME_RESERVED_MESSAGE = "That username is reserved. Choose another.";
export const USERNAME_NOT_ALLOWED_MESSAGE = "That username isn't allowed. Choose another.";

/** Staff and official words refused anywhere in a name ("AdminBob", "TheOwner", "MysticParadoxTeam"). */
const IMPERSONATION_ANYWHERE = [
    "admin", "moderat", "owner", "staff", "support", "official", "developer", "gamemaster", "mysticparadox", "mysticfox", "phoenixlabs"
];

/** Short or common words refused only as the whole name (trailing digits ignored), so ordinary names that contain them still pass. */
const RESERVED_WHOLE = [
    "mod", "mods", "dev", "devs", "gm", "root", "system", "server", "paradox", "dauntless", "null", "undefined", "everyone", "guest",
    "anonymous", "host", "player", "unknown"
];

/** Vulgar, abusive and slur terms refused anywhere in a name: none of them sits inside an ordinary word players would choose. */
const OFFENSIVE_ANYWHERE = [
    "fuck", "shit", "cunt", "bitch", "whore", "slut", "nigg", "faggot", "fagg", "retard", "penis", "vagina", "pussy", "dildo", "porn",
    "jizz", "twat", "wanker", "bollock", "asshole", "arsehole", "motherf", "chink", "tranny", "hitler", "kkk", "molest", "incest",
    "pedophil", "paedo", "sexy", "boob", "killyourself"
];

/**
 * Terms that also occur inside ordinary words or names (Peacock, Grape, Therapist, Raccoon, Torpedo, Sussex, Skyshard, Swanky, Nazir,
 * VanDyke, the Spanish "Kike"): refused only as the whole name.
 */
const OFFENSIVE_WHOLE = [
    "cock", "dick", "rape", "rapist", "coon", "spic", "pedo", "cum", "anal", "sex", "tits", "fag", "nig", "kms", "kys", "homo", "ass",
    "arse", "wank", "nazi", "dyke", "kike", "wtf"
];

/** The forms a name is compared in: lower case, and digits read as the letters they imitate (0=o, 1=i or l, 3=e, 4=a, 5=s, 7=t, 8=b, 9=g). */
function NameForms(username: string): string[] {
    const Lower = username.toLowerCase();
    const Leet = (one: string) => Lower.replace(/[01345789]/g, (digit) =>
        ({ "0": "o", "1": one, "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g" } as Record<string, string>)[digit] ?? digit);
    return [...new Set([Lower, Leet("i"), Leet("l")])];
}

/** Runs of three or more of one letter collapsed to one ("fuuuck" -> "fuck"). Double letters stay, so "Shiitake" never reads "shit". */
function Collapse(text: string): string {
    return text.replace(/(.)\1{2,}/g, "$1");
}

/** Extra substrings from MYSTICPARADOX_USERNAME_BLOCKLIST (comma or space separated, letters and digits; anything else is ignored). */
function OperatorBlocklist(env: NodeJS.ProcessEnv): string[] {
    return (env.MYSTICPARADOX_USERNAME_BLOCKLIST ?? "")
        .split(/[\s,]+/)
        .map((term) => term.trim().toLowerCase())
        .filter((term) => /^[a-z0-9]{2,32}$/.test(term));
}

function ContainsAny(forms: string[], terms: string[]): boolean {
    return forms.some((form) => terms.some((term) => form.includes(term)));
}

/**
 * True when one of the forms, or its collapsed spelling, contains a term. A collapsed spelling is compared only with terms whose own
 * collapsed spelling keeps 4 or more letters, so "nigg" (-> "nig") never matches "Night" through it.
 */
function ContainsTerm(forms: string[], terms: string[]): boolean {
    if (ContainsAny(forms, terms)) return true;
    const CollapsedTerms = terms.map(Collapse).filter((term) => term.length >= 4);
    return ContainsAny(forms.map(Collapse), CollapsedTerms);
}

/** True when a form, without its trailing digits, is one of the terms ("Dick69", "m0d"). */
function IsWhole(forms: string[], terms: string[]): boolean {
    const Bare = new Set<string>();
    for (const form of forms) {
        Bare.add(form);
        Bare.add(form.replace(/[0-9]+$/, ""));
        Bare.add(Collapse(form));
    }
    return terms.some((term) => Bare.has(term));
}

/** Trims edge whitespace, then enforces the format rules. Returns the clean value. */
export function ValidateUsername(raw: unknown): string {
    const username = typeof raw === "string" ? raw.trim() : "";

    if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", `Username must be ${USERNAME_MIN}–${USERNAME_MAX} characters.`);
    }

    if (!USERNAME_PATTERN.test(username)) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", "Username can only contain letters and numbers (no spaces or symbols).");
    }

    if (!/[A-Za-z]/.test(username)) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", "Username needs at least one letter.");
    }

    return username;
}

/**
 * Refuses a name that impersonates staff or the project (USERNAME_RESERVED_MESSAGE) or is vulgar, abusive or a slur, including the
 * operator's own terms (USERNAME_NOT_ALLOWED_MESSAGE, which never says which part matched). Call it after ValidateUsername.
 */
export function AssertUsernameAllowed(username: string, env: NodeJS.ProcessEnv = process.env): void {
    const Forms = NameForms(username.trim());
    if (ContainsTerm(Forms, OFFENSIVE_ANYWHERE) || IsWhole(Forms, OFFENSIVE_WHOLE) || ContainsTerm(Forms, OperatorBlocklist(env))) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", USERNAME_NOT_ALLOWED_MESSAGE);
    }
    if (ContainsTerm(Forms, IMPERSONATION_ANYWHERE) || IsWhole(Forms, RESERVED_WHOLE)) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", USERNAME_RESERVED_MESSAGE);
    }
}
