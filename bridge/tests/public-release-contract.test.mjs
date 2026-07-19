import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { access, copyFile, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const manifestUrl = new URL("../../release/public-files.txt", import.meta.url);
const auditScript = fileURLToPath(new URL("../../release/Test-PublicExport.ps1", import.meta.url));
const exporterScript = fileURLToPath(new URL("../../release/Export-PublicRelease.ps1", import.meta.url));
const repositorySafetyScript = fileURLToPath(new URL("../../tools/Test-RepositorySafety.ps1", import.meta.url));
const ciWorkflowUrl = new URL("../../.github/workflows/ci.yml", import.meta.url);
const securityWorkflowUrl = new URL("../../.github/workflows/security.yml", import.meta.url);
const privateRootPattern = /^(?:Queue|state|handoff|config|src|docs\/superpowers)(?:\/|$)/u;
const maxAuditBytes = 16 * 1024 * 1024;

const readManifest = async () => (await readFile(manifestUrl, "utf8"))
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

const makeAuditRoot = async (t) => {
  const root = await mkdtemp(join(tmpdir(), "public-release-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

const runAudit = (root) => spawnSync(
  "pwsh",
  ["-NoProfile", "-File", auditScript, "-Root", root],
  { encoding: "utf8" },
);

const makeExportSandbox = async (t) => {
  const root = await mkdtemp(join(tmpdir(), "public-release-export-"));
  const source = join(root, "source");
  const release = join(source, "release");
  await mkdir(release, { recursive: true });
  await copyFile(exporterScript, join(release, "Export-PublicRelease.ps1"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, source, release, script: join(release, "Export-PublicRelease.ps1") };
};

const runExporter = (script, destination) => spawnSync(
  "pwsh",
  ["-NoProfile", "-File", script, "-Destination", destination],
  { encoding: "utf8" },
);

test("public release manifest has unique entries", async () => {
  const entries = await readManifest();
  assert.equal(new Set(entries).size, entries.length, "public release manifest contains duplicate entries");
});

test("every public release manifest entry exists", async () => {
  const entries = await readManifest();
  const missing = [];
  for (const entry of entries) {
    try {
      await access(fileURLToPath(new URL(`../../${entry}`, import.meta.url)));
    } catch {
      missing.push(entry);
    }
  }
  assert.deepEqual(missing, [], `public release manifest entries do not exist: ${missing.join(", ")}`);
});

test("CI workflows are credential-free and cover both supported hosts", async () => {
  const ci = await readFile(ciWorkflowUrl, "utf8");
  const security = await readFile(securityWorkflowUrl, "utf8");

  assert.match(ci, /windows-latest/u);
  assert.match(ci, /ubuntu-latest/u);
  assert.match(ci, /node-version:\s*["']?24["']?/u);
  assert.match(ci, /tests[/\\]Run-V3Tests\.ps1/u);
  assert.match(ci, /Run-LocalBridgeE2E\.ps1/u);
  assert.match(ci, /Run-AdaptiveRoutingE2E\.ps1/u);
  assert.match(ci, /Run-NativeInboundRouterE2E\.ps1/u);
  assert.doesNotMatch(ci, /secrets\s*\./iu);
  assert.match(ci, /permissions:\s*\n\s+contents:\s*read/u);

  assert.match(security, /pull_request:/u);
  assert.match(security, /push:\s*\n\s+branches:\s*\[main\]/u);
  assert.match(security, /schedule:/u);
  assert.match(security, /workflow_dispatch:/u);
  assert.match(security, /Test-RepositorySafety\.ps1/u);
  assert.match(security, /gitleaks\/gitleaks-action@[0-9a-f]{40}/u);
  assert.match(security, /actions\/dependency-review-action@[0-9a-f]{40}/u);
  assert.match(security, /github\.event_name\s*==\s*'pull_request'/u);
  assert.match(security, /permissions:\s*\n\s+contents:\s*read/u);
  assert.doesNotMatch(security, /secrets\s*\./iu);
});

const makeTrackedRepository = async (t, files) => {
  const root = await mkdtemp(join(tmpdir(), "repository-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initialized = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  for (const [relativePath, content] of Object.entries(files)) {
    const destination = join(root, relativePath);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
  const added = spawnSync("git", ["-C", root, "add", "--all"], { encoding: "utf8" });
  assert.equal(added.status, 0, added.stderr);
  return root;
};

const runRepositorySafety = (root) => spawnSync(
  "pwsh",
  ["-NoProfile", "-File", repositorySafetyScript, "-Root", root],
  { encoding: "utf8" },
);

test("repository safety audit permits variable references and explicit placeholders", async (t) => {
  const root = await makeTrackedRepository(t, {
    "README.md": "HERMES_TELEGRAM_TOKEN=${HERMES_TELEGRAM_TOKEN}\nTOKEN=<YOUR_TOKEN>\n",
    "config.example": "token=replace_me\n",
  });

  const result = runRepositorySafety(root);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "REPOSITORY_SAFETY_OK");
});

test("repository safety audit rejects tracked runtime paths without leaking contents", async (t) => {
  for (const relativePath of ["Queue/bridge/v3/tasks/task.json", "nested/state/heartbeat.json"]) {
    const root = await makeTrackedRepository(t, { [relativePath]: "private-runtime-marker" });
    const result = runRepositorySafety(root);
    assert.equal(result.status, 1, `${relativePath}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`REPOSITORY_SAFETY_RUNTIME_PATH:${escapeRegExp(relativePath.replaceAll("\\", "/"))}`, "u"));
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /private-runtime-marker/u);
  }
});

test("repository safety audit rejects private keys and credential-shaped values without leaking them", async (t) => {
  const privateKeyMarker = ["-----", "BEGIN PRIVATE KEY", "-----"].join("");
  const credential = ["ghp_7Hk2mN9qR4", "tV8xY3cD6fG1jL5pS0wZ2aB9eC"].join("");
  const cases = [
    ["identity.pem", `${privateKeyMarker}\nsynthetic\n-----END PRIVATE KEY-----\n`, "REPOSITORY_SAFETY_PRIVATE_KEY"],
    ["settings.txt", `token=${credential}\n`, "REPOSITORY_SAFETY_CREDENTIAL"],
  ];
  for (const [relativePath, content, code] of cases) {
    const root = await makeTrackedRepository(t, { [relativePath]: content });
    const result = runRepositorySafety(root);
    assert.equal(result.status, 1, `${relativePath}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`${code}:${escapeRegExp(relativePath)}`, "u"));
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(escapeRegExp(content.trim()), "u"));
  }
});

test("repository safety audit rejects tracked reparse points", async (t) => {
  const root = await makeTrackedRepository(t, { "target.txt": "safe\n" });
  const linked = join(root, "linked.txt");
  try {
    await symlink(join(root, "target.txt"), linked, "file");
  } catch (error) {
    t.skip(`symlink creation unavailable: ${error.code ?? error.message}`);
    return;
  }
  const added = spawnSync("git", ["-C", root, "add", "linked.txt"], { encoding: "utf8" });
  assert.equal(added.status, 0, added.stderr);

  const result = runRepositorySafety(root);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /REPOSITORY_SAFETY_REPARSE:linked\.txt/u);
});

test("public release manifest excludes operational and private roots", async () => {
  const entries = await readManifest();
  assert.deepEqual(
    entries.filter((entry) => privateRootPattern.test(entry)),
    [],
    "public release manifest includes operational or private roots",
  );
});

test("public export audit rejects prohibited path segments at any depth", async (t) => {
  const root = await makeAuditRoot(t);
  const prohibitedDirectories = ["nested/.git", "nested/state", "nested/docs/superpowers"];
  for (const directory of prohibitedDirectories) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, "file.txt"), "public");
  }

  const result = runAudit(root);

  assert.equal(result.status, 1, result.stderr);
  for (const directory of prohibitedDirectories) {
    assert.match(result.stdout, new RegExp(directory.replaceAll("/", "[/\\\\]"), "u"));
  }
});

test("public export audit permits only the dedicated synthetic Queue example subtree", async (t) => {
  const root = await makeAuditRoot(t);
  const example = join(root, "examples", "queue", "bridge", "v3", "interactions", "evt_00000000-0000-4000-8000-000000000001");
  await mkdir(example, { recursive: true });
  await writeFile(join(example, "event.json"), "synthetic documentation record\n");

  const result = runAudit(root);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "PUBLIC_EXPORT_AUDIT_OK");
});

test("public export audit scans BOM-signaled UTF-16 text", async (t) => {
  const root = await makeAuditRoot(t);
  const marker = "Knot" + "Guide";
  const littleEndian = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(marker, "utf16le")]);
  const bigEndianBody = Buffer.from(marker, "utf16le");
  for (let index = 0; index < bigEndianBody.length; index += 2) {
    [bigEndianBody[index], bigEndianBody[index + 1]] = [bigEndianBody[index + 1], bigEndianBody[index]];
  }
  const bigEndian = Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndianBody]);
  await writeFile(join(root, "utf16le.txt"), littleEndian);
  await writeFile(join(root, "utf16be.txt"), bigEndian);

  const result = runAudit(root);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /utf16le\.txt/u);
  assert.match(result.stdout, /utf16be\.txt/u);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(marker, "u"));
});

test("public export audit skips opaque binary content without leaking it", async (t) => {
  const root = await makeAuditRoot(t);
  await writeFile(join(root, "asset.bin"), Buffer.from([0x00, 0xff, 0x01, 0xfe, 0x02]));

  const result = runAudit(root);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "PUBLIC_EXPORT_AUDIT_OK");
});

test("public exporter accepts a normalized relative manifest path", async (t) => {
  const sandbox = await makeExportSandbox(t);
  await mkdir(join(sandbox.source, "docs"), { recursive: true });
  await writeFile(join(sandbox.source, "docs", "file.txt"), "public");
  await writeFile(join(sandbox.release, "public-files.txt"), "docs/file.txt\n");
  const destination = join(sandbox.root, "destination");

  const result = runExporter(sandbox.script, destination);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^PUBLIC_EXPORT_OK:/u);
  assert.equal(await readFile(join(destination, "docs", "file.txt"), "utf8"), "public");
});

test("public exporter rejects every non-normalized manifest path before copying", async (t) => {
  const sandbox = await makeExportSandbox(t);
  await mkdir(join(sandbox.source, "docs"), { recursive: true });
  await writeFile(join(sandbox.source, "docs", "file.txt"), "public");
  const invalidEntries = [
    "../private",
    join(sandbox.root, "rooted.txt"),
    "docs/../file.txt",
    "docs/./file.txt",
    "docs//file.txt",
  ];

  for (const [index, entry] of invalidEntries.entries()) {
    await writeFile(join(sandbox.release, "public-files.txt"), `docs/file.txt\n${entry}\n`);
    const destination = join(sandbox.root, `invalid-destination-${index}`);

    const result = runExporter(sandbox.script, destination);

    assert.equal(result.status, 1, `entry unexpectedly accepted: ${entry}`);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(`EXPORT_MANIFEST_ENTRY_INVALID:${escapeRegExp(entry)}`, "u"));
    await assert.rejects(readFile(join(destination, "docs", "file.txt")), { code: "ENOENT" });
  }
});

test("public exporter rejects destination junctions and junction ancestors", async (t) => {
  if (process.platform !== "win32") {
    t.skip("junction regression requires Windows");
    return;
  }

  const sandbox = await makeExportSandbox(t);
  await mkdir(join(sandbox.source, "docs"), { recursive: true });
  await writeFile(join(sandbox.source, "docs", "file.txt"), "public");
  await writeFile(join(sandbox.release, "public-files.txt"), "docs/file.txt\n");
  const sourceTarget = join(sandbox.source, "destination-target");
  const outsideTarget = join(sandbox.root, "outside-target");
  await mkdir(sourceTarget);
  await mkdir(outsideTarget);
  const directJunction = join(sandbox.root, "direct-junction");
  const ancestorJunction = join(sandbox.root, "ancestor-junction");
  try {
    await symlink(sourceTarget, directJunction, "junction");
    await symlink(outsideTarget, ancestorJunction, "junction");
  } catch (error) {
    t.skip(`junction creation unavailable: ${error.code ?? error.message}`);
    return;
  }

  for (const destination of [directJunction, join(ancestorJunction, "child")]) {
    const result = runExporter(sandbox.script, destination);
    assert.equal(result.status, 1, `junction destination unexpectedly accepted: ${destination}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /EXPORT_DESTINATION_REPARSE_POINT:/u);
  }
  await assert.rejects(readFile(join(sourceTarget, "docs", "file.txt")), { code: "ENOENT" });
});

test("public exporter rejects a reparse point in the source ancestor chain", async (t) => {
  if (process.platform !== "win32") {
    t.skip("junction regression requires Windows");
    return;
  }

  const sandbox = await makeExportSandbox(t);
  const outsideDocs = join(sandbox.root, "outside-docs");
  await mkdir(outsideDocs);
  await writeFile(join(outsideDocs, "secret.txt"), "outside source");
  try {
    await symlink(outsideDocs, join(sandbox.source, "docs"), "junction");
  } catch (error) {
    t.skip(`junction creation unavailable: ${error.code ?? error.message}`);
    return;
  }
  await writeFile(join(sandbox.release, "public-files.txt"), "docs/secret.txt\n");
  const destination = join(sandbox.root, "destination");

  const result = runExporter(sandbox.script, destination);

  assert.equal(result.status, 1, "source ancestor junction was unexpectedly followed");
  assert.match(`${result.stdout}\n${result.stderr}`, /EXPORT_REPARSE_POINT:docs\/secret\.txt/u);
  await assert.rejects(readFile(join(destination, "docs", "secret.txt")), { code: "ENOENT" });
});

test("public export audit fails closed when a file cannot be read", async (t) => {
  if (process.platform !== "win32") {
    t.skip("exclusive file-lock regression requires Windows");
    return;
  }

  const root = await makeAuditRoot(t);
  const lockedPath = join(root, "locked.txt");
  await writeFile(lockedPath, "public");
  const lockCommand = [
    "$stream = [System.IO.File]::Open($env:PUBLIC_EXPORT_LOCK_PATH, [System.IO.FileMode]::Open,",
    "[System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None);",
    "[Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush();",
    "[Console]::ReadLine() | Out-Null; $stream.Dispose()",
  ].join(" ");
  const locker = spawn("pwsh", ["-NoProfile", "-Command", lockCommand], {
    env: { ...process.env, PUBLIC_EXPORT_LOCK_PATH: lockedPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => locker.kill());
  await new Promise((resolve, reject) => {
    let output = "";
    locker.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("LOCKED")) resolve();
    });
    locker.once("error", reject);
    locker.once("exit", (code) => reject(new Error(`locker exited before acquiring lock: ${code}`)));
  });

  const result = runAudit(root);
  const lockerExit = once(locker, "exit");
  locker.stdin.end("\n");
  await lockerExit;

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /PUBLIC_EXPORT_AUDIT_SCAN_ERROR:locked\.txt/u);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /public/u);
});

test("public export audit fails closed on oversized files", async (t) => {
  const root = await makeAuditRoot(t);
  const oversizedPath = join(root, "oversized.bin");
  const handle = await open(oversizedPath, "w");
  await handle.truncate(maxAuditBytes + 1);
  await handle.close();

  const result = runAudit(root);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /PUBLIC_EXPORT_AUDIT_SCAN_ERROR:oversized\.bin/u);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
