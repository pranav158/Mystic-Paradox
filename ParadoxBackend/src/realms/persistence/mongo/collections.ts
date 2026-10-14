// [2026-10-13 realms S2] Collections of the realms module. Additive: all of them stay empty (and are not even created) while
// MYSTICPARADOX_REALMS_MODULE is off. The invites collection uses the invite code as _id, which is what makes a code unique;
// realmPresence uses the account id as _id (one row per account).
export const RealmsCollections = {
    Realms: "realms",
    RealmInvites: "realmInvites",
    RealmPresence: "realmPresence"
} as const;
