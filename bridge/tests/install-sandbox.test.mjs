import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const bridgeRoot = fileURLToPath(new URL("..", import.meta.url));
const install = join(bridgeRoot, "scripts", "Install-Bridge.ps1");
const uninstall = join(bridgeRoot, "scripts", "Uninstall-Bridge.ps1");
const windowsTest = process.platform === "win32" ? test : test.skip;

const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const privateMachinePattern = new RegExp([
  "test-ai-second-", "brain-vault",
  "|C:\\\\Users\\\\", "stigm",
  "|D:\\\\", "Tools",
].join(""), "iu");

function invokePowerShell(script, parameters, { env = {}, home } = {}) {
  const command = [
    home ? `Set-Variable -Name HOME -Value ${psQuote(home)} -Force;` : "",
    "try {",
    `& ${psQuote(script)} ${parameters.join(" ")}`,
    "} catch {",
    "[Console]::Error.WriteLine($_.Exception.Message);",
    "exit 1",
    "}",
  ].join(" ");
  return spawnSync("pwsh", ["-NoProfile", "-Command", command], {
    cwd: bridgeRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function portableInstallParameters(root, extra = []) {
  return [
    "-WhatIf",
    "-SkipScheduledTask",
    "-Confirm:$false",
    "-IntegrationRoot", psQuote(join(root, "integration")),
    "-AllowedWorkspaceRoots", psQuote(join(root, "workspace")),
    "-CodexCommand", psQuote(process.execPath),
    ...extra,
  ];
}

windowsTest("public Windows installation files do not contain developer-specific paths", async () => {
  const combined = (await Promise.all([
    readFile(install, "utf8"),
    readFile(uninstall, "utf8"),
    readFile(join(bridgeRoot, "config.example.json"), "utf8"),
  ])).join("\n").replaceAll("\\\\", "\\");

  assert.doesNotMatch(combined, privateMachinePattern);
});

windowsTest("non-sandbox install requires an explicit integration root", () => {
  const command = [
    "try {",
    `& '${install.replaceAll("'", "''")}' -WhatIf -SkipScheduledTask -Confirm:$false`,
    "} catch {",
    "[Console]::Error.WriteLine($_.Exception.Message);",
    "exit 1",
    "}",
  ].join(" ");
  const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], {
    cwd: bridgeRoot,
    encoding: "utf8",
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.notEqual(result.status, 0, output);
  assert.match(output, /CONFIG_INTEGRATION_ROOT_REQUIRED/u);
  assert.doesNotMatch(output.replaceAll("\\\\", "\\"), privateMachinePattern);
});

windowsTest("install defaults stay under isolated LOCALAPPDATA and CODEX_HOME or HOME", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc3-portable-install-"));
  const localAppData = join(root, "local-app-data");
  const targetRoot = join(localAppData, "HermesCodexBridge");
  const configuredCodexHome = join(root, "configured-codex-home");
  const home = join(root, "home");

  let result = invokePowerShell(install, portableInstallParameters(root), {
    env: { LOCALAPPDATA: localAppData, CODEX_HOME: configuredCodexHome },
    home,
  });
  let output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /TARGET: runtime/u);
  assert.match(output, /TARGET: codex-home/u);
  assert.equal(output.includes(targetRoot), false);
  assert.equal(output.includes(configuredCodexHome), false);

  result = invokePowerShell(install, portableInstallParameters(root), {
    env: { LOCALAPPDATA: localAppData, CODEX_HOME: "" },
    home,
  });
  output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /TARGET: codex-home/u);
  assert.equal(output.includes(join(home, ".codex")), false);
  await assert.rejects(stat(targetRoot), (error) => error?.code === "ENOENT");
});

windowsTest("uninstall uses the same portable TargetRoot default as install", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc3-portable-uninstall-"));
  const localAppData = join(root, "local-app-data");
  const targetRoot = join(localAppData, "HermesCodexBridge");
  const result = invokePowerShell(uninstall, ["-WhatIf", "-SkipScheduledTask", "-Confirm:$false"], {
    env: { LOCALAPPDATA: localAppData, CODEX_HOME: join(root, "codex-home") },
    home: join(root, "home"),
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /TARGET: runtime/u);
  assert.equal(output.includes(targetRoot), false);
  await assert.rejects(stat(targetRoot), (error) => error?.code === "ENOENT");
});

windowsTest("missing LOCALAPPDATA fails without leaking a path", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc3-portable-missing-local-"));
  const result = invokePowerShell(install, portableInstallParameters(root), {
    env: { LOCALAPPDATA: "", CODEX_HOME: join(root, "codex-home") },
    home: join(root, "home"),
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.notEqual(result.status, 0, output);
  assert.equal(output.trim(), "CONFIG_LOCALAPPDATA_REQUIRED");
});

windowsTest("explicit absolute TargetRoot bypasses a missing LOCALAPPDATA", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc3-portable-explicit-target-"));
  const targetRoot = join(root, "explicit-runtime");
  const result = invokePowerShell(install, portableInstallParameters(root, ["-TargetRoot", psQuote(targetRoot)]), {
    env: { LOCALAPPDATA: "", CODEX_HOME: join(root, "codex-home") },
    home: join(root, "home"),
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /TARGET: runtime/u);
  assert.equal(output.includes(targetRoot), false);
  assert.doesNotMatch(output, /CONFIG_LOCALAPPDATA_REQUIRED/u);
  await assert.rejects(stat(targetRoot), (error) => error?.code === "ENOENT");
});

windowsTest("uninstall refuses an unmanifested target and preserves arbitrary user files", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc3-unowned-target-"));
  const targetRoot = join(root, "runtime");
  const marker = join(targetRoot, "USER-OWNED.txt");
  await mkdir(targetRoot, { recursive: true });
  await writeFile(marker, "preserve\n", "utf8");

  let result = invokePowerShell(install, ["-SandboxRoot", psQuote(root), "-SkipScheduledTask", "-Confirm:$false"]);
  let output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.equal(output.trim(), "INSTALL_OWNERSHIP_CONFLICT");
  assert.equal(await readFile(marker, "utf8"), "preserve\n");

  result = invokePowerShell(uninstall, ["-SandboxRoot", psQuote(root), "-SkipScheduledTask", "-Confirm:$false"]);
  output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.equal(output.trim(), "UNINSTALL_OWNERSHIP_UNVERIFIED");
  assert.equal(await readFile(marker, "utf8"), "preserve\n");
  assert.doesNotMatch(output.replaceAll("\\\\", "\\"), new RegExp(root.replaceAll("\\", "\\\\"), "iu"));
});

windowsTest("Windows ownership manifest fails closed when malformed or canonically mismatched", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc3-manifest-reject-"));
  const args = ["-NoProfile", "-File", install, "-SandboxRoot", root, "-SkipScheduledTask", "-Confirm:$false"];
  let result = spawnSync("pwsh", args, { cwd: bridgeRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const manifest = join(root, "runtime", "install-manifest.json");
  const marker = join(root, "runtime", "owned-marker.txt");
  await writeFile(marker, "preserve\n", "utf8");

  await writeFile(manifest, "{not-json}\n", "utf8");
  result = invokePowerShell(uninstall, ["-SandboxRoot", psQuote(root), "-SkipScheduledTask", "-Confirm:$false"]);
  assert.notEqual(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`.trim(), "UNINSTALL_OWNERSHIP_UNVERIFIED");
  assert.equal(await readFile(marker, "utf8"), "preserve\n");

  const mismatch = {
    schema: "hermes-codex-windows-install-manifest/v3",
    targetRoot: join(root, "different-runtime"),
    codexHome: join(root, "codex"),
    stateRoot: join(root, "state"),
    scheduledTask: { name: "HermesCodexBridgeV3", execute: process.execPath, arguments: "mismatch" },
  };
  await writeFile(manifest, JSON.stringify(mismatch), "utf8");
  result = invokePowerShell(uninstall, ["-SandboxRoot", psQuote(root), "-SkipScheduledTask", "-Confirm:$false"]);
  assert.notEqual(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`.trim(), "UNINSTALL_OWNERSHIP_UNVERIFIED");
  assert.equal(await readFile(marker, "utf8"), "preserve\n");
});

windowsTest("uninstall rejects a forged matching manifest behind a TargetRoot junction", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows junction semantics required");
  const root = await mkdtemp(join(tmpdir(), "hc3-junction-root-"));
  const userData = await mkdtemp(join(tmpdir(), "hc3-user-data-"));
  const targetRoot = join(root, "runtime");
  const codexHome = join(root, "codex");
  const stateRoot = join(root, "state");
  const marker = join(userData, "USER-OWNED.txt");
  await mkdir(codexHome, { recursive: true });
  await writeFile(marker, "preserve\n", "utf8");
  try {
    await symlink(userData, targetRoot, "junction");
  } catch (error) {
    return t.skip(`Windows junction creation unavailable: ${error?.code ?? "unknown"}`);
  }
  const taskArguments = `"${join(targetRoot, "src", "cli.mjs")}" run --config "${join(targetRoot, "config.json")}"`;
  await writeFile(join(userData, "install-manifest.json"), JSON.stringify({
    schema: "hermes-codex-windows-install-manifest/v3",
    targetRoot,
    codexHome,
    stateRoot,
    scheduledTask: { name: "HermesCodexBridgeV3", execute: process.execPath, arguments: taskArguments },
  }), "utf8");

  let result = invokePowerShell(install, ["-SandboxRoot", psQuote(root), "-SkipScheduledTask", "-Confirm:$false"]);
  let output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.equal(output.trim(), "SAFETY_REPARSE_POINT");
  assert.equal(await readFile(marker, "utf8"), "preserve\n");

  result = invokePowerShell(uninstall, ["-SandboxRoot", psQuote(root), "-SkipScheduledTask", "-Confirm:$false"]);
  output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.equal(output.trim(), "SAFETY_REPARSE_POINT");
  assert.equal(await readFile(marker, "utf8"), "preserve\n");
  assert.doesNotMatch(output.replaceAll("\\\\", "\\"), new RegExp(root.replaceAll("\\", "\\\\"), "iu"));
});

windowsTest("uninstall rejects a direct child junction inside an owned runtime", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows junction semantics required");
  const root = await mkdtemp(join(tmpdir(), "hc3-child-junction-root-"));
  const userData = await mkdtemp(join(tmpdir(), "hc3-child-user-data-"));
  const targetRoot = join(root, "runtime");
  const codexHome = join(root, "codex");
  const stateRoot = join(root, "state");
  const marker = join(userData, "USER-OWNED.txt");
  await mkdir(targetRoot, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(marker, "preserve\n", "utf8");
  try {
    await symlink(userData, join(targetRoot, "linked-user-data"), "junction");
  } catch (error) {
    return t.skip(`Windows junction creation unavailable: ${error?.code ?? "unknown"}`);
  }
  const taskArguments = `"${join(targetRoot, "src", "cli.mjs")}" run --config "${join(targetRoot, "config.json")}"`;
  await writeFile(join(targetRoot, "install-manifest.json"), JSON.stringify({
    schema: "hermes-codex-windows-install-manifest/v3",
    targetRoot,
    codexHome,
    stateRoot,
    scheduledTask: { name: "HermesCodexBridgeV3", execute: process.execPath, arguments: taskArguments },
  }), "utf8");

  const result = invokePowerShell(uninstall, ["-SandboxRoot", psQuote(root), "-SkipScheduledTask", "-Confirm:$false"]);
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.equal(output.trim(), "SAFETY_REPARSE_POINT");
  assert.equal(await readFile(marker, "utf8"), "preserve\n");
});

windowsTest("scheduled task lifecycle is ownership-checked, started, health-polled, and never force-overwritten", async () => {
  const installText = await readFile(install, "utf8");
  const uninstallText = await readFile(uninstall, "utf8");
  assert.doesNotMatch(installText, /Register-ScheduledTask[^\n]*-Force/iu);
  assert.match(installText, /INSTALL_TASK_OWNERSHIP_CONFLICT/u);
  assert.match(installText, /Start-ScheduledTask/u);
  assert.match(installText, /INSTALL_HEALTH_TIMEOUT/u);
  assert.match(installText, /heartbeat\.json/u);
  assert.match(uninstallText, /UNINSTALL_TASK_OWNERSHIP_UNVERIFIED/u);
  assert.match(uninstallText, /\.Actions/iu);
  assert.match(uninstallText, /Unregister-ScheduledTask/u);
});

windowsTest("actual PowerShell install/uninstall paths are sandboxed, idempotent, and preserve GSD hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc3-install-"));
  const codex = join(root, "codex"); const hooks = join(codex, "hooks.json");
  await mkdir(join(codex, "sessions"), { recursive: true });
  const original = { hooks: { Stop: [{ hooks: [{ type: "command", command: "node C:\\safe\\gsd-hook.mjs", timeout: 10 }] }], Notification: [{ matcher: "keep-gsd" }] } };
  await writeFile(hooks, JSON.stringify(original));
  const args = ["-NoProfile", "-File", install, "-SandboxRoot", root, "-SkipScheduledTask", "-Confirm:$false"];
  let result = spawnSync("pwsh", args, { cwd: bridgeRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  let installedConfig = JSON.parse(await readFile(join(root, "runtime", "config.json"), "utf8"));
  assert.equal(installedConfig.uiRouterMode, "external");
  await stat(join(root, "integration", "v3", "windows", "ui-router-cli.mjs"));
  await stat(join(root, "integration", "v3", "windows", "UI_ROUTER_PROMPT.md"));
  installedConfig.uiRouterMode = "native";
  await writeFile(join(root, "runtime", "config.json"), JSON.stringify(installedConfig), "utf8");
  result = spawnSync("pwsh", args, { cwd: bridgeRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const configText = await readFile(join(root, "runtime", "config.json"), "utf8");
  assert.doesNotMatch(configText, /token|chatId|password|secret/iu);
  installedConfig = JSON.parse(configText);
  assert.equal(installedConfig.uiRouterMode, "native");
  assert.equal(installedConfig.codexCommand.toLowerCase(), process.execPath.toLowerCase());
  const installedHooks = JSON.parse(await readFile(hooks, "utf8"));
  assert.equal(installedHooks.hooks.Notification[0].matcher, "keep-gsd");
  assert.equal(installedHooks.hooks.SessionStart.filter((entry) => JSON.stringify(entry).includes("hook-adapter.mjs")).length, 1);
  assert.equal(installedHooks.hooks.Stop.filter((entry) => JSON.stringify(entry).includes("hook-adapter.mjs")).length, 1);
  await stat(join(root, "queue", "protocol", "v3", "protocol.json"));
  await stat(join(root, "integration", "v3", "hermes", "watcher.py"));
  await stat(join(root, "integration", "v3", "hermes", "inbound.py"));
  await stat(join(root, "integration", "v3", "hermes", "test_contracts.py"));
  await stat(join(root, "integration", "v3", "hermes", "test_inbound.py"));
  await stat(join(root, "integration", "v3", "hermes", "test_watcher.py"));
  await stat(join(root, "integration", "v3", "hermes", "doctor.py"));
  await stat(join(root, "integration", "v3", "hermes", "test_doctor.py"));
  await stat(join(root, "integration", "v3", "hermes", "templates", "hermes-codex-bridge.service.in"));
  await stat(join(root, "integration", "v3", "hermes", "templates", "SKILL.md.in"));
  await stat(join(root, "integration", "v3", "hermes", "scripts", "install.sh"));
  await stat(join(root, "integration", "v3", "hermes", "scripts", "uninstall.sh"));
  await stat(join(root, "runtime", "install-manifest.json"));
  await stat(join(root, "state"));
  for (const relative of [
    join("src", "codex-command-resolver.mjs"),
    join("src", "candidate-store.mjs"),
    join("src", "notification-gate.mjs"),
    join("src", "windows-presence.mjs"),
    join("scripts", "Get-WindowsPresence.ps1"),
  ]) await stat(join(root, "runtime", relative));
  const installedHermes = join(root, "integration", "v3", "hermes");
  const python = spawnSync("python", ["-m", "unittest", "discover", "-s", ".", "-p", "test_*.py", "-v"], {
    cwd: installedHermes,
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(python.status, 0, python.stderr);
  assert.equal((await import("node:fs")).existsSync(join(root, "scheduled-task.json")), false);
  result = spawnSync("pwsh", ["-NoProfile", "-File", uninstall, "-SandboxRoot", root, "-SkipScheduledTask", "-Confirm:$false"], { cwd: bridgeRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const finalHooks = JSON.parse(await readFile(hooks, "utf8"));
  assert.deepEqual(finalHooks, original);
  await stat(join(root, "queue", "protocol", "v3", "protocol.json"));
  await stat(join(root, "integration", "v3", "hermes", "watcher.py"));
  result = spawnSync("pwsh", ["-NoProfile", "-File", uninstall, "-SandboxRoot", root, "-SkipScheduledTask", "-Confirm:$false"], { cwd: bridgeRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
