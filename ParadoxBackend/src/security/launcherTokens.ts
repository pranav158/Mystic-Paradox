/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import jwt, { JwtPayload } from "jsonwebtoken";
import crypto from "crypto";







const LAUNCHER_AUDIENCE = "mysticparadox-launcher";
const ISSUER = "paradox-backend";
const ACCESS_TOKEN_TTL = "12m";

function GetPrivateKey(): string {
    return Buffer.from(process.env.AUTH_SIGNING_PRIVKEY_B64!, "base64").toString("utf-8");
}

function GetPublicKey(): string {
    return Buffer.from(process.env.AUTH_SIGNING_PUBKEY_B64!, "base64").toString("utf-8");
}

export interface LauncherAccessTokenPayload {
    userId: string;
    
    sid: string;
}

export function SignLauncherAccessToken(payload: LauncherAccessTokenPayload): string {
    return jwt.sign(payload, GetPrivateKey(), {
        algorithm: "RS256",
        expiresIn: ACCESS_TOKEN_TTL,
        issuer: ISSUER,
        audience: LAUNCHER_AUDIENCE
    });
}

export function ValidateLauncherAccessToken(token: string): LauncherAccessTokenPayload {
    const Payload = jwt.verify(token, GetPublicKey(), {
        algorithms: ["RS256"],
        issuer: ISSUER,
        audience: LAUNCHER_AUDIENCE
    }) as JwtPayload;

    return { userId: Payload.userId, sid: Payload.sid };
}




export function GenerateOpaqueToken(): string {
    return crypto.randomBytes(32).toString("hex");
}

export function HashOpaqueToken(token: string): string {
    return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}
