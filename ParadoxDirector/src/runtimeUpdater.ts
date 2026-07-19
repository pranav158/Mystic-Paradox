import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { logger } from "./logger";

const execFileAsync = promisify(execFile);
const TARGET_CHANGELIST = 392819;
const MAX_RUNTIME_BYTES = 200 * 1024 * 1024;
const DEFAULT_MANIFEST_URL =
  "https://paradox.example.com/launcher/v1/runtime/server/stable/windows-x86_64";
const RUNTIME_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA3ZMtA7qUgs1F+1NQs2kmSG2zbOvXfjsh6+axI6eC/tc=
-----END PUBLIC KEY-----`;

type RuntimeManifest = {
  schema: 1;
  component: "ParadoxRuntime";
  target: "server";
  version: string;
  channel: string;
  targetChangelist: number;
  platform: "windows-x86_64";
  size: number;
  sha256: string;
  signature: string;
  url: string;
};

function enabled(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name]?.trim() ?? "");
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function parseManifest(value: unknown): RuntimeManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime update manifest is not an object");
  }
  const data = value as Record<string, unknown>;
  if (
    data.schema !== 1 ||
    data.component !== "ParadoxRuntime" ||
    data.target !== "server" ||
    data.targetChangelist !== TARGET_CHANGELIST ||
    data.platform !== "windows-x86_64" ||
    typeof data.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(data.version) ||
    typeof data.channel !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(data.channel) ||
    typeof data.size !== "number" ||
    !Number.isSafeInteger(data.size) ||
    data.size <= 0 ||
    data.size > MAX_RUNTIME_BYTES ||
    typeof data.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.sha256) ||
    typeof data.signature !== "string" ||
    typeof data.url !== "string"
  ) {
    throw new Error("Runtime update manifest failed validation");
  }
  return data as RuntimeManifest;
}

async function request(url: URL): Promise<Response> {
  return fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { "User-Agent": "MysticParadox-DeployServer/0.0.3" },
  });
}

function validateTransport(url: URL, expectedOrigin?: string): void {
  if (url.protocol !== "https:" && !(url.protocol === "http:" && enabled("SERVER_RUNTIME_ALLOW_HTTP"))) {
    throw new Error("Runtime updates require HTTPS (or SERVER_RUNTIME_ALLOW_HTTP=true for local development)");
  }
  if (url.username || url.password) throw new Error("Runtime update URLs may not contain credentials");
  if (expectedOrigin && url.origin !== expectedOrigin) {
    throw new Error("Runtime artifact URL must use the same origin as the manifest");
  }
}

async function isDauntlessRunning(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const { stdout } = await execFileAsync("tasklist.exe", [
    "/FI",
    "IMAGENAME eq Dauntless-Win64-Shipping.exe",
    "/FO",
    "CSV",
    "/NH",
  ]);
  return stdout.toLowerCase().includes("dauntless-win64-shipping.exe");
}

function replaceAtomically(destination: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staged = `${destination}.update-${process.pid}.tmp`;
  const backup = `${destination}.bak`;
  fs.rmSync(staged, { force: true });
  fs.writeFileSync(staged, bytes, { flag: "wx" });
  let movedOld = false;
  try {
    if (fs.existsSync(destination)) {
      fs.rmSync(backup, { force: true });
      fs.renameSync(destination, backup);
      movedOld = true;
    }
    fs.renameSync(staged, destination);
  } catch (error) {
    fs.rmSync(staged, { force: true });
    if (movedOld && !fs.existsSync(destination) && fs.existsSync(backup)) {
      fs.renameSync(backup, destination);
    }
    throw error;
  }
}

export async function EnsureServerRuntimeUpdated(): Promise<void> {
  if (!enabled("SERVER_RUNTIME_AUTO_UPDATE")) {
    logger.info("Server runtime auto-update is disabled");
    return;
  }

  const binaryPath = process.env.GAMESERVER_BINARY_PATH?.trim();
  if (!binaryPath) throw new Error("GAMESERVER_BINARY_PATH is required for server runtime updates");
  const dllPath = path.resolve(
    process.env.GAMESERVER_RUNTIME_DLL_PATH?.trim() ||
      path.join(path.dirname(path.resolve(binaryPath)), "MysticParadox.dll"),
  );
  const manifestUrl = new URL(process.env.SERVER_RUNTIME_MANIFEST_URL?.trim() || DEFAULT_MANIFEST_URL);
  validateTransport(manifestUrl);

  const manifestResponse = await request(manifestUrl);
  if (manifestResponse.status === 404 || manifestResponse.status === 204) {
    logger.info("No server runtime update is published");
    return;
  }
  if (!manifestResponse.ok) throw new Error(`Runtime manifest request failed with HTTP ${manifestResponse.status}`);
  const manifest = parseManifest(await manifestResponse.json());

  if (fs.existsSync(dllPath)) {
    const currentHash = sha256(fs.readFileSync(dllPath));
    if (currentHash === manifest.sha256) {
      logger.info({ version: manifest.version, sha256: currentHash }, "Server runtime is current");
      return;
    }
  }
  if (await isDauntlessRunning()) {
    throw new Error("A Dauntless process is running; refusing to replace the server runtime DLL");
  }

  const artifactUrl = new URL(manifest.url, manifestUrl);
  validateTransport(artifactUrl, manifestUrl.origin);
  const artifactResponse = await request(artifactUrl);
  if (!artifactResponse.ok) throw new Error(`Runtime artifact request failed with HTTP ${artifactResponse.status}`);
  const declaredLength = Number(artifactResponse.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RUNTIME_BYTES) {
    throw new Error("Runtime artifact exceeds the maximum size");
  }
  const bytes = Buffer.from(await artifactResponse.arrayBuffer());
  if (bytes.length !== manifest.size || bytes.length > MAX_RUNTIME_BYTES || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error("Runtime artifact size or PE header is invalid");
  }
  const actualHash = sha256(bytes);
  if (actualHash !== manifest.sha256) throw new Error("Runtime artifact SHA-256 mismatch");
  let signature: Buffer;
  try {
    signature = Buffer.from(manifest.signature, "base64");
  } catch {
    signature = Buffer.alloc(0);
  }
  if (signature.length !== 64 || !crypto.verify(null, bytes, RUNTIME_PUBLIC_KEY, signature)) {
    throw new Error("Runtime artifact signature verification failed");
  }

  replaceAtomically(dllPath, bytes);
  logger.info({ version: manifest.version, sha256: actualHash, path: dllPath }, "Installed signed server runtime update");
}
