#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const releaseName = `Agent-Teams-Builder-v${version}`;
const outputRoot = path.join(root, "output", "release");
const stage = path.join(outputRoot, releaseName);
const archive = path.join(root, "dist", `${releaseName}.zip`);
const nodeVersion = process.env.VIXO_BUNDLED_NODE_VERSION || process.versions.node;
const nodeBase = `https://nodejs.org/dist/v${nodeVersion}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout || result.error?.message || "unknown error").trim()}`);
  return result;
}

function copy(source, destination, options = {}) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, ...options });
}

async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Unable to download ${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, bytes);
  return bytes;
}

async function addNodeRuntime(target, checksumMap, temporary) {
  const filename = target === "windows-x64"
    ? `node-v${nodeVersion}-win-x64.zip`
    : `node-v${nodeVersion}-darwin-${target.endsWith("arm64") ? "arm64" : "x64"}.tar.gz`;
  const expected = checksumMap.get(filename);
  if (!expected) throw new Error(`Node checksum is missing for ${filename}`);
  const downloaded = path.join(temporary, filename);
  const bytes = await download(`${nodeBase}/${filename}`, downloaded);
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`Node checksum mismatch for ${filename}`);
  const extracted = path.join(temporary, target);
  fs.mkdirSync(extracted, { recursive: true });
  if (filename.endsWith(".zip")) run("unzip", ["-q", downloaded, "-d", extracted]);
  else run("tar", ["-xzf", downloaded, "-C", extracted]);
  const distribution = path.join(extracted, filename.replace(/\.(?:tar\.gz|zip)$/, ""));
  const destination = path.join(stage, "runtime", target);
  fs.mkdirSync(destination, { recursive: true });
  if (target === "windows-x64") {
    copy(path.join(distribution, "node.exe"), path.join(destination, "node.exe"));
    copy(path.join(distribution, "node_modules", "npm"), path.join(destination, "node_modules", "npm"));
  } else {
    copy(path.join(distribution, "bin", "node"), path.join(destination, "node"));
    fs.chmodSync(path.join(destination, "node"), 0o755);
    copy(path.join(distribution, "lib", "node_modules", "npm"), path.join(destination, "lib", "node_modules", "npm"));
  }
}

function createMacApp() {
  const app = path.join(stage, "Install Agent Teams Builder.app", "Contents");
  const executable = path.join(app, "MacOS", "installer");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, [
    "#!/bin/bash",
    "ROOT=\"$(cd \"$(dirname \"$0\")/../../..\" && pwd)\"",
    "open -a Terminal \"$ROOT/install.command\"",
    ""
  ].join("\n"), { encoding: "utf8", mode: 0o755 });
  fs.writeFileSync(path.join(app, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>installer</string>
<key>CFBundleIdentifier</key><string>tw.lazyoffice.vixo-agent-teams-installer</string>
<key>CFBundleName</key><string>Install Agent Teams Builder</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>
`, "utf8");
}

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const relative of [
  ".agents",
  ".claude-plugin",
  "docs",
  "Install-Agent-Builder.cmd",
  "Install-Agent-Builder.ps1",
  "install.command",
  "LICENSE",
  "README.md",
  "README-安裝說明.md",
  "TEST-REPORT.md",
  "package.json",
  "scripts/install.mjs"
]) copy(path.join(root, relative), path.join(stage, relative));
copy(path.join(root, "plugins", "agent-teams-builder"), path.join(stage, "plugins", "agent-teams-builder"), {
  filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`) && !source.endsWith(`${path.sep}node_modules`)
});
run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: path.join(stage, "plugins", "agent-teams-builder")
});

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vixo-release-runtime-"));
try {
  const checksumsFile = path.join(temporary, "SHASUMS256.txt");
  await download(`${nodeBase}/SHASUMS256.txt`, checksumsFile);
  const checksumMap = new Map(fs.readFileSync(checksumsFile, "utf8").trim().split(/\r?\n/).map((line) => {
    const [hash, name] = line.trim().split(/\s+/);
    return [name.replace(/^\*/, ""), hash];
  }));
  for (const target of ["macos-arm64", "macos-x64", "windows-x64"]) await addNodeRuntime(target, checksumMap, temporary);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

createMacApp();
run("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", path.join(stage, "Install-Agent-Builder.exe"), "./launchers/windows-installer/main.go"], {
  cwd: root,
  env: { ...process.env, GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" }
});

const files = [];
for (const entry of fs.readdirSync(stage, { recursive: true })) {
  const full = path.join(stage, entry);
  if (!fs.statSync(full).isFile()) continue;
  const hash = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
  files.push(`${hash}  ${entry}`);
}
files.sort();
fs.writeFileSync(path.join(stage, "SHA256SUMS.txt"), `${files.join("\n")}\n`, "utf8");
fs.mkdirSync(path.dirname(archive), { recursive: true });
fs.rmSync(archive, { force: true });
if (process.platform === "darwin") run("ditto", ["-c", "-k", "--norsrc", "--keepParent", stage, archive]);
else run("zip", ["-qry", archive, releaseName], { cwd: outputRoot });
const archiveHash = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
fs.writeFileSync(`${archive}.sha256`, `${archiveHash}  ${path.basename(archive)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ version, stage, archive, archiveHash, nodeVersion }, null, 2)}\n`);
