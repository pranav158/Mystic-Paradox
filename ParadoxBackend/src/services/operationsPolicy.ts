import { GetMongoDb } from "../persistence/mongo/client";
import { Collections } from "../persistence/mongo/collections";
import { ClientSession } from "mongodb";
import { ApplyDiagnosticsLogProfile, logger } from "../logger";
import { GetP2PExtension } from "../extensions/p2p";

export type GuardEnforcement = "OBSERVE" | "ENFORCE";
export type DiagnosticsProfile = "PRODUCTION" | "DEVELOPMENT";

// One singleton document (`operationsPolicy`, _id "global") with a shared optimistic `version`.
// An optional module may keep its own fields in the same document (src/extensions).
export interface OperationsPolicy {
    guardEnforcement: GuardEnforcement;
    diagnosticsProfile: DiagnosticsProfile;
    version: number;
    updatedAt?: string;
    updatedBy?: string;
    diagnosticsExpiresAt?: string;
}

export const DEFAULT_OPERATIONS_POLICY: Readonly<OperationsPolicy> = {
    // A missing singleton is a deployment fault; these values cover the interval before repair.
    guardEnforcement: "ENFORCE",
    diagnosticsProfile: "PRODUCTION",
    version: 0
};

export function OperationsPolicyWeakeningCodes(before: OperationsPolicy,
    after: Pick<OperationsPolicy, "guardEnforcement" | "diagnosticsProfile">): string[] {
    const codes: string[] = [];
    if (before.guardEnforcement === "ENFORCE" && after.guardEnforcement === "OBSERVE") {
        codes.push("GUARD_DOWNGRADE");
    }
    if (before.diagnosticsProfile === "PRODUCTION" && after.diagnosticsProfile === "DEVELOPMENT") {
        codes.push("DEVELOPMENT_DIAGNOSTICS");
    }
    return codes;
}

/**
 * `extensionFieldsValid` is false when an optional module's fields of the same document are
 * malformed; the whole document then fails closed like a malformed core field.
 */
export function NormalizeOperationsPolicyRecord(record: any, now = Date.now(), extensionFieldsValid = true): {
    policy: OperationsPolicy;
    malformed: boolean;
} {
    const guardValid = record?.guardEnforcement === "OBSERVE" || record?.guardEnforcement === "ENFORCE";
    const diagnosticsValid = record?.diagnosticsProfile === "PRODUCTION" || record?.diagnosticsProfile === "DEVELOPMENT";
    const malformed = !guardValid || !diagnosticsValid || !extensionFieldsValid;
    const diagnosticsExpiresAt = typeof record?.diagnosticsExpiresAt === "string"
        ? record.diagnosticsExpiresAt : undefined;
    // A malformed Guard/diagnostics policy must not enable expanded logging.
    const diagnosticsActive = !malformed && diagnosticsValid && record.diagnosticsProfile === "DEVELOPMENT" &&
        diagnosticsExpiresAt != undefined && Date.parse(diagnosticsExpiresAt) > now;
    return {
        malformed,
        policy: {
            guardEnforcement: !malformed && guardValid ? record.guardEnforcement : "ENFORCE",
            diagnosticsProfile: diagnosticsActive ? "DEVELOPMENT" : "PRODUCTION",
            version: Number.isSafeInteger(record?.version) && record.version > 0 ? record.version : 0,
            updatedAt: typeof record?.updatedAt === "string" ? record.updatedAt : undefined,
            updatedBy: typeof record?.updatedBy === "string" ? record.updatedBy : undefined,
            diagnosticsExpiresAt: diagnosticsActive ? diagnosticsExpiresAt : undefined
        }
    };
}

export function ResolveDiagnosticsExpiry(current: OperationsPolicy,
    requestedProfile: DiagnosticsProfile, now = Date.now()): string | undefined {
    if (requestedProfile !== "DEVELOPMENT") return undefined;
    const existingExpiry = current.diagnosticsProfile === "DEVELOPMENT"
        ? current.diagnosticsExpiresAt : undefined;
    // Guard/reward edits submit the complete policy document. Preserve an already-active diagnostics
    // lease so those unrelated edits cannot silently renew verbose logging. A new lease is issued
    // only when production/expired diagnostics explicitly transition back to DEVELOPMENT.
    if (existingExpiry != undefined && Date.parse(existingExpiry) > now) return existingExpiry;
    return new Date(now + 2 * 60 * 60_000).toISOString();
}

/** The raw singleton document (null when missing). */
export async function ReadOperationsPolicyRecord(session?: ClientSession): Promise<any | null> {
    const db = await GetMongoDb();
    return db.collection(Collections.OperationsPolicy).findOne({ _id: "global" as any }, { session });
}

/** Normalizes a document read by ReadOperationsPolicyRecord() and applies its logging profile. */
export function ResolveOperationsPolicy(record: any | null, session?: ClientSession): OperationsPolicy {
    if (record == undefined) {
        // Reads inside a Mongo transaction must not mutate process-wide logging before that
        // transaction commits. Non-transactional reads represent durable policy and may apply it.
        if (session == undefined) ApplyDiagnosticsLogProfile(DEFAULT_OPERATIONS_POLICY.diagnosticsProfile);
        return { ...DEFAULT_OPERATIONS_POLICY };
    }
    const normalized = NormalizeOperationsPolicyRecord(record, Date.now(),
        GetP2PExtension().operations.policyFieldsValid(record));
    if (normalized.malformed) {
        logger.error("[OperationsPolicy] malformed global policy; forcing Guard ENFORCE and production diagnostics");
    }
    if (session == undefined) ApplyDiagnosticsLogProfile(normalized.policy.diagnosticsProfile);
    if (process.env.GUARD_ENFORCEMENT_OVERRIDE === "OBSERVE") {
        normalized.policy.guardEnforcement = "OBSERVE";
    }
    return normalized.policy;
}

export async function GetOperationsPolicy(session?: ClientSession): Promise<OperationsPolicy> {
    return ResolveOperationsPolicy(await ReadOperationsPolicyRecord(session), session);
}

export async function SetOperationsPolicy(input: Pick<OperationsPolicy, "guardEnforcement" | "diagnosticsProfile">,
    actorUserId: string, expectedVersion: number,
    session?: ClientSession): Promise<OperationsPolicy | undefined> {
    const db = await GetMongoDb();
    const updatedAt = new Date().toISOString();
    const current = await GetOperationsPolicy(session);
    const diagnosticsExpiresAt = ResolveDiagnosticsExpiry(current, input.diagnosticsProfile,
        Date.parse(updatedAt));
    const result = await db.collection(Collections.OperationsPolicy).updateOne(
        { _id: "global" as any, version: expectedVersion },
        { $set: { guardEnforcement: input.guardEnforcement, diagnosticsProfile: input.diagnosticsProfile,
            updatedAt, updatedBy: actorUserId, ...(diagnosticsExpiresAt ? { diagnosticsExpiresAt } : {}) },
            $unset: diagnosticsExpiresAt ? {} : { diagnosticsExpiresAt: "" }, $inc: { version: 1 } },
        { session }
    );
    if (result.modifiedCount !== 1) return undefined;
    return GetOperationsPolicy(session);
}
