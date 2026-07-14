#!/usr/bin/env node
// Validate the actual arm64 .app emitted by electron-builder, not workspace node_modules.

const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DESKTOP_DIR = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, "package.json"), "utf8"));
const releaseDir = path.join(DESKTOP_DIR, "release", packageJson.version);
const app = path.join(releaseDir, "mac-arm64", "OpenTrad.app");
const executable = path.join(app, "Contents", "MacOS", "OpenTrad");
const resources = path.join(app, "Contents", "Resources");
const unpackedModules = path.join(resources, "app.asar.unpacked", "node_modules");
const sqliteUnpacked = path.join(unpackedModules, "better-sqlite3");
const ptyUnpacked = path.join(unpackedModules, "node-pty");
const asarModules = path.join(resources, "app.asar", "node_modules");
const sqlite = path.join(asarModules, "better-sqlite3");
const pty = path.join(asarModules, "node-pty");
const launcher = path.join(resources, "hermes", "opentrad_hermes_launcher.py");
const requirements = path.join(resources, "hermes", "hermes-agent-0.18.2-base-requirements.txt");
const retiredRuntime = path.join(resources, "hermes", "opentrad_hermes_runtime.py");
const dmg = path.join(releaseDir, `OpenTrad-${packageJson.version}-arm64.dmg`);
const sourceLauncher = path.join(DESKTOP_DIR, "resources", "hermes", "opentrad_hermes_launcher.py");

const required = [executable, sqliteUnpacked, ptyUnpacked, launcher, requirements, dmg];
for (const candidate of required) {
  if (!fs.existsSync(candidate)) fail(`missing packaged artifact: ${candidate}`);
}
if (fs.existsSync(retiredRuntime)) fail("retired Hermes quarantine runtime was packaged");
if (!fs.readFileSync(launcher).equals(fs.readFileSync(sourceLauncher))) {
  fail("packaged Hermes launcher differs from the source resource");
}

const requirementsSha256 = createHash("sha256").update(fs.readFileSync(requirements)).digest("hex");
if (requirementsSha256 !== "f852f46604256f6d5a5d4adf550fcfac411756c5dc264414add0361b7d7d8f2d") {
  fail("packaged Hermes requirements lock hash mismatch");
}

const architectures = spawnSync("/usr/bin/lipo", ["-archs", executable], {
  encoding: "utf8",
  timeout: 15_000,
});
if (architectures.status !== 0 || architectures.stdout.trim() !== "arm64") {
  fail("packaged Electron executable is not arm64");
}

const testCode = `
const Database = require(process.argv[1]);
const db = new Database(":memory:");
if (db.prepare("select 42 as value").get().value !== 42) process.exit(2);
const pty = require(process.argv[2]);
if (typeof pty.spawn !== "function") process.exit(3);
if (process.arch !== "arm64") process.exit(4);
const child = pty.spawn("/usr/bin/printf", ["opentrad-pty-smoke"], {
  cols: 80,
  rows: 24,
  cwd: "/tmp",
  env: { PATH: "/usr/bin:/bin" },
});
let output = "";
const timer = setTimeout(() => process.exit(5), 5000);
child.onData((data) => { output += data; });
child.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (exitCode !== 0 || !output.includes("opentrad-pty-smoke")) process.exit(6);
  console.log("packaged native smoke OK ABI=" + process.versions.modules + " arch=" + process.arch);
});
`;
const nativeSmoke = spawnSync(executable, ["-e", testCode, sqlite, pty], {
  cwd: DESKTOP_DIR,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_OPTIONS: "",
  },
  stdio: "inherit",
  timeout: 15_000,
});
if (nativeSmoke.status !== 0) {
  fail(
    `packaged native smoke failed (status=${nativeSmoke.status}, signal=${nativeSmoke.signal}, error=${nativeSmoke.error?.message ?? "none"})`,
  );
}

const dmgVerify = spawnSync("/usr/bin/hdiutil", ["verify", dmg], {
  stdio: "inherit",
  timeout: 120_000,
});
if (dmgVerify.status !== 0) fail("packaged DMG verification failed");

const mountPoint = path.join(
  "/tmp",
  `opentrad-dmg-smoke-${process.pid}-${Date.now().toString(16)}`,
);
fs.mkdirSync(mountPoint, { mode: 0o700 });
let mountFailure;
try {
  const attach = spawnSync(
    "/usr/bin/hdiutil",
    ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, dmg],
    { stdio: "inherit", timeout: 120_000 },
  );
  if (attach.status !== 0) throw new Error("packaged DMG mount failed");
  const mountedResources = path.join(mountPoint, "OpenTrad.app", "Contents", "Resources");
  if (!fs.existsSync(path.join(mountedResources, "app.asar"))) {
    throw new Error("packaged DMG does not contain OpenTrad.app");
  }
  if (
    !fs
      .readFileSync(path.join(mountedResources, "hermes", path.basename(launcher)))
      .equals(fs.readFileSync(sourceLauncher))
  ) {
    throw new Error("DMG contains a stale Hermes launcher");
  }
  const mountedRequirements = path.join(mountedResources, "hermes", path.basename(requirements));
  if (
    !fs.existsSync(mountedRequirements) ||
    !fs.readFileSync(mountedRequirements).equals(fs.readFileSync(requirements))
  ) {
    throw new Error("DMG is missing or changed the Hermes requirements lock");
  }
} catch (error) {
  mountFailure = error instanceof Error ? error.message : "packaged DMG inspection failed";
} finally {
  const detach = spawnSync("/usr/bin/hdiutil", ["detach", mountPoint, "-force"], {
    stdio: "inherit",
    timeout: 30_000,
  });
  if (!mountFailure && detach.status !== 0) mountFailure = "packaged DMG detach failed";
  fs.rmSync(mountPoint, { force: true, recursive: true });
}
if (mountFailure) fail(mountFailure);

console.log("[smoke:packaged] PASS");

function fail(message) {
  console.error(`[smoke:packaged] FAIL: ${message}`);
  process.exit(1);
}
