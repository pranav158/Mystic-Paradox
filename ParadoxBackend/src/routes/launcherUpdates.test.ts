import assert from "node:assert/strict";
import test from "node:test";
import {
    AllowedRuntimeExtraFiles,
    DecideLauncherUpdate,
    LauncherDownloadTarget,
    LauncherInstallerPath,
    LauncherUpdateUrlPrefixes,
    UpdaterManifest,
    validateGuardManifestWindow,
} from "./launcherUpdates";

const NOW = Date.parse("2026-09-09T00:00:00.000Z");

test("Guard manifest window accepts a current, future-expiring manifest", () => {
    assert.doesNotThrow(() => validateGuardManifestWindow(
        "2026-09-08T23:59:00.000Z",
        "2026-09-09T01:00:00.000Z",
        NOW,
    ));
});

test("Guard manifest window rejects an issue time beyond the clock-skew bound", () => {
    assert.throws(() => validateGuardManifestWindow(
        "2026-09-09T00:05:01.000Z",
        "2026-09-09T01:00:00.000Z",
        NOW,
    ), /too far in the future/);
});

test("Guard manifest window rejects expired manifests", () => {
    assert.throws(() => validateGuardManifestWindow(
        "2026-09-08T23:00:00.000Z",
        "2026-09-08T23:59:59.000Z",
        NOW,
    ), /expired/);
});

test("Guard manifest window rejects reversed timestamps", () => {
    assert.throws(() => validateGuardManifestWindow(
        "2026-09-09T00:30:00.000Z",
        "2026-09-09T00:20:00.000Z",
        NOW,
    ), /not after/);
});

test("Guard manifest window rejects a lifetime beyond the publisher bound", () => {
    assert.throws(() => validateGuardManifestWindow(
        "2026-01-01T00:00:00.000Z",
        "2027-01-01T00:00:00.001Z",
        NOW,
    ), /maximum allowed window/);
});

test("Guard manifest window rejects malformed timestamps", () => {
    assert.throws(() => validateGuardManifestWindow("not-a-time", "2026-09-09T01:00:00.000Z", NOW), /invalid/);
});

test("runtime extra files are the winmm proxy plus the configured safe names", () => {
    const previous = process.env.RUNTIME_EXTRA_FILES;
    try {
        delete process.env.RUNTIME_EXTRA_FILES;
        assert.deepEqual([...AllowedRuntimeExtraFiles()], ["winmm.dll"]);
        process.env.RUNTIME_EXTRA_FILES = " Coop-Transport.dll, coop-admission.key ,../evil.dll,";
        assert.deepEqual([...AllowedRuntimeExtraFiles()], ["winmm.dll", "coop-transport.dll", "coop-admission.key"]);
    } finally {
        if (previous === undefined) delete process.env.RUNTIME_EXTRA_FILES;
        else process.env.RUNTIME_EXTRA_FILES = previous;
    }
});

// [2026-10-15] Launcher self-update manifests (RELEASING.md): GitHub-hosted installers and the old self-hosted layout.
const BASE = "https://paradox.example.net";
const RELEASES = "https://github.com/pranav158/Mystic-Paradox/releases/download/";
const PREFIXES = LauncherUpdateUrlPrefixes({}, BASE);
const githubManifest = (version = "0.1.64", over: Record<string, unknown> = {}): Record<string, unknown> => ({
    version,
    notes: "update",
    pub_date: "2026-10-15T10:00:00.000Z",
    url: `${RELEASES}launcher-v${version}/Mystic.Paradox.Launcher_${version}_x64-setup.exe`,
    signature: "c2lnbmF0dXJl",
    sha256: "0".repeat(64),
    size: 5_000_000,
    ...over,
});

test("launcher update prefixes: this backend's update route, then the public repo's releases unless configured", () => {
    assert.deepEqual(PREFIXES, [`${BASE}/launcher/v1/updates/`, RELEASES]);
    assert.deepEqual(
        LauncherUpdateUrlPrefixes({ LAUNCHER_UPDATE_URL_PREFIXES: " https://github.com/a/b/releases/download/ ,http://insecure/,https://no-slash,https://q/?x=1/" }, BASE),
        [`${BASE}/launcher/v1/updates/`, "https://github.com/a/b/releases/download/"],
    );
});

test("a GitHub-hosted manifest is offered to older launchers only", () => {
    assert.deepEqual(DecideLauncherUpdate(githubManifest(), "0.1.63", PREFIXES), { offer: true });
    assert.deepEqual(DecideLauncherUpdate(githubManifest(), "0.1.64", PREFIXES), { offer: false, reason: "up to date" });
    assert.deepEqual(DecideLauncherUpdate(githubManifest(), "0.2.0", PREFIXES), { offer: false, reason: "up to date" });
    assert.deepEqual(DecideLauncherUpdate(githubManifest("0.1.10"), "0.1.9", PREFIXES), { offer: true });
    assert.deepEqual(DecideLauncherUpdate(undefined, "0.1.63", PREFIXES), { offer: false, reason: "no launcher manifest" });
});

test("a manifest pointing elsewhere, over http, with a query, unsigned or without a version is not offered", () => {
    for (const manifest of [
        githubManifest("0.1.64", { url: "https://evil.example/x_0.1.64_x64-setup.exe" }),
        githubManifest("0.1.64", { url: `${RELEASES.replace("https:", "http:")}v/x.exe` }),
        githubManifest("0.1.64", { url: `${RELEASES}v/x.exe?redirect=1` }),
        githubManifest("0.1.64", { url: RELEASES }),
        githubManifest("0.1.64", { signature: "" }),
        githubManifest("0.1.64-beta"),
    ]) {
        assert.equal(DecideLauncherUpdate(manifest, "0.1.63", PREFIXES).offer, false, JSON.stringify(manifest.url ?? manifest.version));
    }
});

test("the old self-hosted layout (file + this backend's download route) still works", () => {
    const selfHosted = githubManifest("0.1.42", { file: "Mystic Paradox Launcher_0.1.42_x64-setup.exe", url: `${BASE}/launcher/v1/updates/windows/x86_64/download` });
    assert.deepEqual(DecideLauncherUpdate(selfHosted, "0.1.41", PREFIXES), { offer: true });
    assert.deepEqual(LauncherDownloadTarget(selfHosted, PREFIXES), { kind: "file", version: "0.1.42", file: "Mystic Paradox Launcher_0.1.42_x64-setup.exe" });
    assert.equal(LauncherDownloadTarget({ ...selfHosted, file: "../escape.exe" }, PREFIXES), undefined);
});

test("the download route redirects to an allowed release download, never to itself or elsewhere", () => {
    const manifest = githubManifest();
    assert.deepEqual(LauncherDownloadTarget(manifest, PREFIXES), { kind: "redirect", url: manifest.url });
    assert.equal(LauncherDownloadTarget(githubManifest("0.1.64", { url: `${BASE}/launcher/v1/updates/windows/x86_64/download` }), PREFIXES), undefined);
    assert.equal(LauncherDownloadTarget(githubManifest("0.1.64", { url: "https://evil.example/x.exe" }), PREFIXES), undefined);
    assert.equal(LauncherDownloadTarget(undefined, PREFIXES), undefined);
});

// [2026-10-15] Self-hosted installers (GITHUB_RELEASES.md): the manager writes launcher/<target>/<arch>/<version>/<file>.
const ownName = (version: string): string => `MysticParadoxLauncher_${version}_x64-setup.exe`;
const ownManifest = (version = "0.1.64"): Record<string, unknown> => githubManifest(version, {
    url: `${BASE}/launcher/v1/updates/windows/x86_64/files/${version}/${ownName(version)}`,
    file: ownName(version),
});

test("a self-hosted manifest is offered only while its installer is on this server", () => {
    const seen: string[] = [];
    const onDisk = (present: boolean) => (version: string, file: string): boolean => {
        seen.push(`${version}/${file}`);
        return present;
    };
    assert.deepEqual(DecideLauncherUpdate(ownManifest(), "0.1.63", PREFIXES, onDisk(true)), { offer: true });
    assert.deepEqual(seen, [`0.1.64/${ownName("0.1.64")}`]);
    assert.deepEqual(DecideLauncherUpdate(ownManifest(), "0.1.63", PREFIXES, onDisk(false)), { offer: false, reason: "the manifest's installer is not on this server" });
    // An up-to-date launcher is answered before the disk is looked at; a GitHub manifest never asks.
    assert.deepEqual(DecideLauncherUpdate(ownManifest(), "0.1.64", PREFIXES, onDisk(false)), { offer: false, reason: "up to date" });
    assert.deepEqual(DecideLauncherUpdate(githubManifest(), "0.1.63", PREFIXES, onDisk(false)), { offer: true });
});

test("the updater gets only Tauri's fields", () => {
    assert.deepEqual(Object.keys(UpdaterManifest(ownManifest())).sort(), ["notes", "pub_date", "signature", "url", "version"]);
    assert.deepEqual(UpdaterManifest({ version: "0.1.64", url: "u", signature: "s" }), { version: "0.1.64", url: "u", signature: "s" });
});

test("the versioned installer route serves only this version's installer names, inside the update root", () => {
    const root = "/srv/updates";
    const ok = LauncherInstallerPath(root, "windows", "x86_64", "0.1.64", ownName("0.1.64"));
    assert.ok(ok !== undefined && ok.endsWith(ownName("0.1.64")) && ok.includes("0.1.64"));
    for (const [target, arch, version, file] of [
        ["windows", "x86_64", "0.1.64", "Mystic Paradox Launcher_0.1.64_x64-setup.exe"],
        ["windows", "x86_64", "0.1.64", ownName("0.1.63")],
        ["windows", "x86_64", "0.1", "MysticParadoxLauncher_0.1_x64-setup.exe"],
        ["windows", "x86_64", "0.1.64", "latest.json"],
        ["windows", "x86_64", "0.1.64", "..%2F" + ownName("0.1.64")],
        ["..", "x86_64", "0.1.64", ownName("0.1.64")],
        ["windows", "x86_64", "../0.1.64", ownName("0.1.64")],
    ]) {
        assert.equal(LauncherInstallerPath(root, target, arch, version, file), undefined, `${target}/${arch}/${version}/${file}`);
    }
});
