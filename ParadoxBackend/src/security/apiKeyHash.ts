import crypto from "node:crypto";

const MIN_SECRET_LENGTH = 32;

function ApiKeyHashSecret(): Buffer {
    const secret = process.env.API_KEY_HASH_SECRET?.trim();
    if (!secret || secret.length < MIN_SECRET_LENGTH) {
        throw new Error("API_KEY_HASH_SECRET must contain at least 32 characters.");
    }
    return Buffer.from(secret, "utf8");
}

export function HashApiKey(
    value: string,
    scope: "gameserver" | "user",
): string {
    return crypto
        .createHmac("sha256", ApiKeyHashSecret())
        .update(scope, "utf8")
        .update("\0")
        .update(value, "utf8")
        .digest("hex");
}
