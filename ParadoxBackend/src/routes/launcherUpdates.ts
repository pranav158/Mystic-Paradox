import express, { Router, Request, Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";



const UPDATE_ROOT = path.resolve(process.env.LAUNCHER_UPDATE_ROOT ?? path.join(process.cwd(), "updates"));
const RUNTIME_TARGETS = new Set(["client", "server"]);
const UPDATE_PUBLIC_BASE_URL = (process.env.UPDATE_PUBLIC_BASE_URL ?? "https://paradox.example.com").replace(/\/$/, "");
const RUNTIME_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA3ZMtA7qUgs1F+1NQs2kmSG2zbOvXfjsh6+axI6eC/tc=\n-----END PUBLIC KEY-----`;



function normalizeIp(value: string | undefined | null): string {
    if (!value) return "";
    let ip = value.trim();
    if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);
    const zone = ip.indexOf("%");
    if (zone >= 0) ip = ip.slice(0, zone);
    return ip.toLowerCase();
}





const UPDATE_PUBLISHER_ALLOWED_IPS = new Set(
    (process.env.UPDATE_PUBLISHER_ALLOWED_IPS ?? "")
        .split(",")
        .map((value) => normalizeIp(value))
        .filter((value) => value.length > 0),
);




function isPublisherIpAllowed(req: Request): boolean {
    if (UPDATE_PUBLISHER_ALLOWED_IPS.size === 0) return false;
    const candidates = [normalizeIp(req.ip), normalizeIp(req.socket?.remoteAddress)];
    return candidates.some((ip) => ip.length > 0 && UPDATE_PUBLISHER_ALLOWED_IPS.has(ip));
}


function hasValidPublisherKey(req: Request): boolean {
    const expectedKey = process.env.UPDATE_PUBLISHER_API_KEY?.trim();
    const providedKey = req.header("x-update-api-key")?.trim();
    if (!expectedKey || !providedKey || expectedKey.length !== providedKey.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(expectedKey), Buffer.from(providedKey)); } catch { return false; }
}





const SERVING_FLAG_PATH = path.join(UPDATE_ROOT, "serving.json");
function isRuntimeServingEnabled(): boolean {
    try {
        const parsed = JSON.parse(fs.readFileSync(SERVING_FLAG_PATH, "utf8")) as { runtimeEnabled?: boolean };
        return parsed.runtimeEnabled !== false;
    } catch {
        return true;
    }
}
function setRuntimeServingEnabled(enabled: boolean): void {
    fs.mkdirSync(UPDATE_ROOT, { recursive: true });
    fs.writeFileSync(SERVING_FLAG_PATH, `${JSON.stringify({ runtimeEnabled: enabled, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

export const launcherUpdatesRouter = Router();

function segment(value: string, label: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
        throw new Error(`Invalid ${label}`);
    }
    return value;
}

function readJson(file: string): Record<string, unknown> | undefined {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

function runtimeManifestPath(target: string, channel: string, platform: string): string {
    return path.join(UPDATE_ROOT, "runtime", segment(target, "target"), segment(channel, "channel"), segment(platform, "platform"), "latest.json");
}

function serveRuntimeManifest(target: string, channel: string, platform: string, res: Response): void {
    try {
        
        
        if (!isRuntimeServingEnabled()) {
            res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            res.sendStatus(204);
            return;
        }
        const manifest = readJson(runtimeManifestPath(target, channel, platform));
        if (!manifest) {
            res.sendStatus(404);
            return;
        }
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.json(manifest);
    } catch {
        res.sendStatus(400);
    }
}

function serveRuntimeDownload(target: string, channel: string, platform: string, res: Response): void {
    try {
        const safeTarget = segment(target, "target");
        const safeChannel = segment(channel, "channel");
        const safePlatform = segment(platform, "platform");
        const manifest = readJson(runtimeManifestPath(safeTarget, safeChannel, safePlatform));
        const version = typeof manifest?.version === "string" ? segment(manifest.version, "version") : undefined;
        const file = typeof manifest?.file === "string" ? path.basename(manifest.file) : undefined;
        if (!version || !file || file !== manifest?.file) {
            res.sendStatus(404);
            return;
        }
        const artifact = path.join(UPDATE_ROOT, "runtime", safeTarget, safeChannel, safePlatform, version, file);
        if (!fs.existsSync(artifact)) {
            res.sendStatus(404);
            return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", fs.statSync(artifact).size);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        fs.createReadStream(artifact).pipe(res);
    } catch {
        res.sendStatus(400);
    }
}

launcherUpdatesRouter.get("/launcher/v1/runtime/:target/:channel/:platform", (req, res) => {
    if (!RUNTIME_TARGETS.has(req.params.target)) { res.sendStatus(400); return; }
    serveRuntimeManifest(req.params.target, req.params.channel, req.params.platform, res);
});


launcherUpdatesRouter.get("/launcher/v1/runtime/:channel/:platform", (req, res) => {
    serveRuntimeManifest("client", req.params.channel, req.params.platform, res);
});

launcherUpdatesRouter.get("/launcher/v1/runtime/:target/:channel/:platform/download", (req, res) => {
    if (!RUNTIME_TARGETS.has(req.params.target)) { res.sendStatus(400); return; }
    serveRuntimeDownload(req.params.target, req.params.channel, req.params.platform, res);
});

launcherUpdatesRouter.get("/launcher/v1/runtime/:channel/:platform/download", (req, res) => {
    serveRuntimeDownload("client", req.params.channel, req.params.platform, res);
});

launcherUpdatesRouter.post(
    "/launcher/v1/admin/updates/runtime/:target/:channel/:platform",
    express.raw({ type: "application/octet-stream", limit: "200mb" }),
    (req: Request, res: Response) => {
        if (!isPublisherIpAllowed(req)) {
            console.warn(`[update] publish denied for ${normalizeIp(req.ip) || "unknown"} (not in UPDATE_PUBLISHER_ALLOWED_IPS)`);
            res.status(403).json({ error: "Update publishing is not allowed from this address." });
            return;
        }
        const expectedKey = process.env.UPDATE_PUBLISHER_API_KEY?.trim();
        const providedKey = req.header("x-update-api-key")?.trim();
        if (!expectedKey || !providedKey || expectedKey.length !== providedKey.length ||
            !crypto.timingSafeEqual(Buffer.from(expectedKey), Buffer.from(providedKey))) {
            res.status(401).json({ error: "Invalid update publisher credentials." });
            return;
        }
        const target = String(req.params.target);
        const channel = String(req.params.channel);
        const platform = String(req.params.platform);
        const version = req.header("x-update-version") ?? "";
        const changelist = Number(req.header("x-update-changelist"));
        const signatureText = req.header("x-update-signature") ?? "";
        if (!RUNTIME_TARGETS.has(target) || !/^[A-Za-z0-9._-]+$/.test(channel) || platform !== "windows-x86_64" ||
            !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) || changelist !== 392819 || !Buffer.isBuffer(req.body)) {
            res.status(400).json({ error: "Invalid runtime update metadata." });
            return;
        }
        const bytes = req.body as Buffer;
        if (bytes.length === 0 || bytes.length > 200 * 1024 * 1024) {
            res.status(413).json({ error: "Runtime update is outside the allowed size." });
            return;
        }
        let signature: Buffer;
        try { signature = Buffer.from(signatureText, "base64"); } catch { signature = Buffer.alloc(0); }
        if (signature.length !== 64 || !crypto.verify(null, bytes, RUNTIME_PUBLIC_KEY, signature)) {
            res.status(400).json({ error: "Runtime update signature verification failed." });
            return;
        }
        const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
        const artifactName = `ParadoxRuntime-${version}-${target}-392819.dll`;
        const artifactDir = path.join(UPDATE_ROOT, "runtime", target, channel, platform, version);
        fs.mkdirSync(artifactDir, { recursive: true });
        const artifactPath = path.join(artifactDir, artifactName);
        if (fs.existsSync(artifactPath)) {
            res.status(409).json({ error: "That target/channel/version is already published and immutable." });
            return;
        }
        fs.writeFileSync(artifactPath, bytes, { flag: "wx" });
        const manifest = {
            schema: 1, component: "ParadoxRuntime", target, version, channel, targetChangelist: changelist,
            platform, size: bytes.length, sha256, signature: signatureText, file: artifactName,
            publishedAt: new Date().toISOString(),
            url: `${UPDATE_PUBLIC_BASE_URL}/launcher/v1/runtime/${encodeURIComponent(target)}/${encodeURIComponent(channel)}/${platform}/download`,
            extraFiles: [] as { name: string; size: number; sha256: string; signature: string; url: string }[],
        };
        const latestDir = path.join(UPDATE_ROOT, "runtime", target, channel, platform);
        fs.mkdirSync(latestDir, { recursive: true });
        fs.writeFileSync(path.join(artifactDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        fs.writeFileSync(path.join(latestDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        res.status(201).json({ target, channel, version, sha256 });
    },
);




launcherUpdatesRouter.post(
    "/launcher/v1/admin/updates/runtime/:target/:channel/:platform/extra",
    express.raw({ type: "application/octet-stream", limit: "200mb" }),
    (req: Request, res: Response) => {
        if (!isPublisherIpAllowed(req)) {
            console.warn(`[update] extra-file publish denied for ${normalizeIp(req.ip) || "unknown"}`);
            res.status(403).json({ error: "Update publishing is not allowed from this address." });
            return;
        }
        const expectedKey = process.env.UPDATE_PUBLISHER_API_KEY?.trim();
        const providedKey = req.header("x-update-api-key")?.trim();
        if (!expectedKey || !providedKey || expectedKey.length !== providedKey.length ||
            !crypto.timingSafeEqual(Buffer.from(expectedKey), Buffer.from(providedKey))) {
            res.status(401).json({ error: "Invalid update publisher credentials." });
            return;
        }
        let target: string, channel: string, platform: string, version: string, filename: string;
        try {
            target = segment(String(req.params.target), "target");
            channel = segment(String(req.params.channel), "channel");
            platform = segment(String(req.params.platform), "platform");
            version = segment(req.header("x-update-version") ?? "", "version");
            filename = segment(path.basename(req.header("x-update-filename") ?? ""), "filename");
        } catch { res.status(400).json({ error: "Invalid extra-file metadata." }); return; }
        if (!RUNTIME_TARGETS.has(target) || platform !== "windows-x86_64" || !filename.toLowerCase().endsWith(".dll")) {
            res.status(400).json({ error: "Invalid extra-file target/platform/name." }); return;
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0 || req.body.length > 200 * 1024 * 1024) {
            res.status(413).json({ error: "Extra file is outside the allowed size." }); return;
        }
        const bytes = req.body as Buffer;
        let signature: Buffer;
        try { signature = Buffer.from(req.header("x-update-signature") ?? "", "base64"); } catch { signature = Buffer.alloc(0); }
        if (signature.length !== 64 || !crypto.verify(null, bytes, RUNTIME_PUBLIC_KEY, signature)) {
            res.status(400).json({ error: "Extra file signature verification failed." }); return;
        }
        const versionDir = path.join(UPDATE_ROOT, "runtime", target, channel, platform, version);
        const latestPath = runtimeManifestPath(target, channel, platform);
        const manifest = readJson(latestPath) as any;
        if (!fs.existsSync(versionDir) || !manifest || manifest.version !== version) {
            res.status(409).json({ error: "Publish the main runtime DLL for this version first." }); return;
        }
        const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
        fs.writeFileSync(path.join(versionDir, filename), bytes);
        const extra = {
            name: filename, size: bytes.length, sha256, signature: signature.toString("base64"),
            url: `${UPDATE_PUBLIC_BASE_URL}/launcher/v1/runtime/${encodeURIComponent(target)}/${encodeURIComponent(channel)}/${platform}/extra/${encodeURIComponent(filename)}`,
        };
        const extras = Array.isArray(manifest.extraFiles) ? manifest.extraFiles.filter((e: any) => e && e.name !== filename) : [];
        extras.push(extra);
        manifest.extraFiles = extras;
        fs.writeFileSync(path.join(versionDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        fs.writeFileSync(latestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        res.status(201).json({ name: filename, sha256, size: bytes.length });
    },
);


launcherUpdatesRouter.get("/launcher/v1/runtime/:target/:channel/:platform/extra/:filename", (req, res) => {
    if (!RUNTIME_TARGETS.has(req.params.target)) { res.sendStatus(400); return; }
    try {
        const target = segment(req.params.target, "target");
        const channel = segment(req.params.channel, "channel");
        const platform = segment(req.params.platform, "platform");
        const filename = segment(path.basename(req.params.filename), "filename");
        const manifest = readJson(runtimeManifestPath(target, channel, platform)) as any;
        const version = typeof manifest?.version === "string" ? segment(manifest.version, "version") : undefined;
        const extras = Array.isArray(manifest?.extraFiles) ? manifest.extraFiles : [];
        const known = extras.find((e: any) => e && e.name === filename);
        if (!version || !known) { res.sendStatus(404); return; }
        const artifact = path.join(UPDATE_ROOT, "runtime", target, channel, platform, version, filename);
        if (!fs.existsSync(artifact)) { res.sendStatus(404); return; }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", fs.statSync(artifact).size);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        fs.createReadStream(artifact).pipe(res);
    } catch { res.sendStatus(400); }
});





launcherUpdatesRouter.get("/launcher/v1/admin/updates/serving", (req: Request, res: Response) => {
    if (!isPublisherIpAllowed(req)) { res.status(403).json({ error: "Not allowed from this address." }); return; }
    if (!hasValidPublisherKey(req)) { res.status(401).json({ error: "Invalid update publisher credentials." }); return; }
    res.json({ runtimeEnabled: isRuntimeServingEnabled() });
});

launcherUpdatesRouter.post("/launcher/v1/admin/updates/serving", express.json({ limit: "4kb" }), (req: Request, res: Response) => {
    if (!isPublisherIpAllowed(req)) {
        console.warn(`[update] serving toggle denied for ${normalizeIp(req.ip) || "unknown"} (not in UPDATE_PUBLISHER_ALLOWED_IPS)`);
        res.status(403).json({ error: "Not allowed from this address." });
        return;
    }
    if (!hasValidPublisherKey(req)) { res.status(401).json({ error: "Invalid update publisher credentials." }); return; }
    const enabled = (req.body as { runtimeEnabled?: unknown })?.runtimeEnabled;
    if (typeof enabled !== "boolean") { res.status(400).json({ error: "runtimeEnabled must be a boolean." }); return; }
    setRuntimeServingEnabled(enabled);
    console.warn(`[update] runtime update serving ${enabled ? "ENABLED" : "DISABLED"} by ${normalizeIp(req.ip)}`);
    res.json({ runtimeEnabled: enabled });
});











launcherUpdatesRouter.get("/launcher/v1/updates/:target/:arch/download", (req, res) => {
    try {
        const target = segment(req.params.target, "target");
        const arch = segment(req.params.arch, "architecture");
        const manifest = readJson(path.join(UPDATE_ROOT, "launcher", target, arch, "latest.json"));
        const version = typeof manifest?.version === "string" ? segment(manifest.version, "version") : undefined;
        const file = typeof manifest?.file === "string" ? path.basename(manifest.file) : undefined;
        if (!version || !file || file !== manifest?.file) {
            res.sendStatus(404);
            return;
        }
        const artifact = path.join(UPDATE_ROOT, "launcher", target, arch, version, file);
        if (!fs.existsSync(artifact)) {
            res.sendStatus(404);
            return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", fs.statSync(artifact).size);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        fs.createReadStream(artifact).pipe(res);
    } catch {
        res.sendStatus(400);
    }
});

launcherUpdatesRouter.get("/launcher/v1/updates/:target/:arch/:currentVersion", (req, res) => {
    try {
        const file = path.join(
            UPDATE_ROOT,
            "launcher",
            segment(req.params.target, "target"),
            segment(req.params.arch, "architecture"),
            "latest.json",
        );
        const manifest = readJson(file);
        if (!manifest) {
            res.sendStatus(204);
            return;
        }
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.json(manifest);
    } catch {
        res.sendStatus(400);
    }
});
