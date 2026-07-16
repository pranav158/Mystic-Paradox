/*
 * Copyright (C) 2026 Mystic Paradox (pranav158/MysticParadox)
 * Licensed under the GNU Affero General Public License v3.0.
 */

import crypto from "crypto";

function DecodeBase32(input: string): Buffer {
    const Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const Clean = input.toUpperCase().replace(/[\s=-]/g, "");
    let Bits = "";
    for (const Character of Clean) {
        const Index = Alphabet.indexOf(Character);
        if (Index < 0) throw new Error("Invalid base32 secret");
        Bits += Index.toString(2).padStart(5, "0");
    }
    const Bytes: number[] = [];
    for (let Offset = 0; Offset + 8 <= Bits.length; Offset += 8) {
        Bytes.push(Number.parseInt(Bits.slice(Offset, Offset + 8), 2));
    }
    return Buffer.from(Bytes);
}

function CodeAt(secret: Buffer, counter: number): string {
    const BufferCounter = Buffer.alloc(8);
    BufferCounter.writeBigUInt64BE(BigInt(counter));
    const Digest = crypto.createHmac("sha1", secret).update(BufferCounter).digest();
    const Offset = Digest[Digest.length - 1] & 0x0f;
    const NumberCode = (Digest.readUInt32BE(Offset) & 0x7fffffff) % 1_000_000;
    return NumberCode.toString().padStart(6, "0");
}

export function VerifyTotp(base32Secret: string, candidate: unknown, nowMs = Date.now()): boolean {
    if (typeof candidate !== "string" || !/^\d{6}$/.test(candidate)) return false;
    let Secret: Buffer;
    try {
        Secret = DecodeBase32(base32Secret);
    } catch {
        return false;
    }
    const Counter = Math.floor(nowMs / 30_000);
    return [-1, 0, 1].some((Window) => {
        const Expected = Buffer.from(CodeAt(Secret, Counter + Window));
        const Actual = Buffer.from(candidate);
        return Expected.length === Actual.length && crypto.timingSafeEqual(Expected, Actual);
    });
}
