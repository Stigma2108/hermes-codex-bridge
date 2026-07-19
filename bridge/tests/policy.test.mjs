import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { classifyApproval } from "../src/policy.mjs";

const config = { allowedWorkspaceRoots: ["D:\\Project Codex"], realpathSync: (path) => path };

test("allows explicit safe one-time commands inside a configured Windows workspace", () => {
  const commands = [
    "npm test",
    "npm run lint",
    "pnpm test -- --runInBand",
    "pnpm lint",
    "yarn check",
    "yarn run build",
    "node --test tests/policy.test.mjs",
    "python -m pytest tests",
    "pytest -q",
    "dotnet test",
    "cargo check",
    "Get-Location",
    "git status --short",
    "git diff --stat",
    "git log --oneline -5",
  ];

  for (const command of commands) {
    assert.equal(
      classifyApproval({ command, cwd: "D:\\Project Codex\\Knots", action: "APPROVE_ONCE" }, config),
      "REMOTE_ALLOWED",
      command,
    );
  }
});

test("uses case-insensitive segment-aware normalized Windows root containment", () => {
  assert.equal(classifyApproval({ command: "npm test", cwd: "d:\\PROJECT CODEX\\Knots\\." }, config), "REMOTE_ALLOWED");
  assert.equal(classifyApproval({ command: "npm test", cwd: "D:\\Project Codex" }, config), "REMOTE_ALLOWED");
  assert.equal(classifyApproval({ command: "npm test", cwd: "D:\\Project Codex Evil" }, config), "LOCAL_ONLY");
  assert.equal(classifyApproval({ command: "npm test", cwd: "D:\\Project Codex\\..\\Outside" }, config), "LOCAL_ONLY");
  assert.equal(classifyApproval({ command: "npm test", cwd: "C:\\Project Codex\\Knots" }, config), "LOCAL_ONLY");
});

test("broad workspace roots never authorize bridge protected subtrees", () => {
  const broad = {
    allowedWorkspaceRoots: ["D:\\Tools"],
    queueRoot: "D:\\Tools\\vault\\Queue\\bridge\\v3",
    stateRoot: "D:\\Tools\\hermes-codex-bridge-v3\\state",
    codexHome: "D:\\Tools\\codex-home",
    realpathSync: (path) => path,
  };
  assert.equal(classifyApproval({ command: "Get-Location", cwd: "D:\\Tools\\Project", action: "APPROVE_ONCE" }, broad), "REMOTE_ALLOWED");
  for (const cwd of [broad.queueRoot, broad.stateRoot, broad.codexHome]) {
    assert.equal(classifyApproval({ command: "Get-Location", cwd, action: "APPROVE_ONCE" }, broad), "LOCAL_ONLY", cwd);
  }
  assert.equal(
    classifyApproval({ command: "node --check hermes-codex-bridge-v3\\state\\evil.mjs", cwd: "D:\\Tools", action: "APPROVE_ONCE" }, broad),
    "LOCAL_ONLY",
  );
});

test("denies malformed or ambiguous request and configuration without throwing", () => {
  const malformed = [
    [null, config],
    [{}, config],
    [{ command: ["npm test"], cwd: "D:\\Project Codex" }, config],
    [{ command: "npm test", cwd: null }, config],
    [{ command: "npm test", cwd: "relative\\path" }, config],
    [{ command: "npm test", cwd: "D:\\Project Codex" }, null],
    [{ command: "npm test", cwd: "D:\\Project Codex" }, { allowedWorkspaceRoots: [] }],
    [{ command: "npm test", cwd: "D:\\Project Codex" }, { allowedWorkspaceRoots: [""] }],
    [{ command: "npm test", cwd: "D:\\Project Codex" }, { allowedWorkspaceRoots: ["relative"] }],
  ];
  for (const [request, valueConfig] of malformed) {
    assert.doesNotThrow(() => classifyApproval(request, valueConfig));
    assert.equal(classifyApproval(request, valueConfig), "LOCAL_ONLY");
  }
});

test("denies session, persistent, and non-once decisions", () => {
  const requests = [
    { forSession: true },
    { persistent: true },
    { forSession: "false" },
    { decision: "APPROVE_FOR_SESSION" },
    { decision: "accept" },
    { action: "APPROVE_ALWAYS" },
    { action: "DECLINE" },
  ];
  for (const fields of requests) {
    assert.equal(
      classifyApproval({ command: "npm test", cwd: "D:\\Project Codex\\Knots", ...fields }, config),
      "LOCAL_ONLY",
    );
  }
});

test("blocked destructive, system, publication, secret, network and external-effect tokens always win", () => {
  const commands = [
    "Remove-Item -Recurse D:\\Data",
    "npm test Remove-Item -Recurse data",
    "git push origin main",
    "git reset --hard HEAD~1",
    "git clean -fdx",
    "npm publish",
    "npm run deploy",
    "systemctl restart xray",
    "sc.exe stop service",
    "reg.exe add HKLM\\Software\\Fixture",
    "schtasks /create /tn fixture",
    "netsh advfirewall set allprofiles state off",
    "type C:\\Users\\me\\.ssh\\id_ed25519",
    "Get-Content auth.json",
    "ssh host.example",
    "scp file host:/tmp",
    "curl https://example.test",
    "Invoke-WebRequest https://example.test",
    "Invoke-RestMethod https://example.test",
    "send-email --to user@example.test",
    "charge-payment --amount 5",
  ];
  for (const command of commands) {
    assert.equal(classifyApproval({ command, cwd: "D:\\Project Codex\\Knots" }, config), "LOCAL_ONLY", command);
  }
});

test("denies chaining, redirection, subshells, expansion, traversal and absolute command paths", () => {
  const commands = [
    "npm test; git status",
    "npm test && git status",
    "npm test | Out-File result.txt",
    "npm test > result.txt",
    "npm test $(whoami)",
    "npm test `whoami`",
    "npm test ^& whoami",
    "node --test ..\\outside.test.mjs",
    "node --test C:\\outside\\fixture.test.mjs",
    "node --test --test-reporter=C:\\outside\\reporter.mjs",
    "node --test \\\\server\\share\\fixture.test.mjs",
    "node --test --test-reporter=\\\\server\\share\\reporter.mjs",
    "node --test ~\\fixture.test.mjs",
    "node --test %TEMP%\\fixture.test.mjs",
    "node --test $env:TEMP\\fixture.test.mjs",
  ];
  for (const command of commands) {
    assert.equal(classifyApproval({ command, cwd: "D:\\Project Codex\\Knots" }, config), "LOCAL_ONLY", command);
  }
});

test("denies unknown commands even when they are project-local", () => {
  for (const command of ["whoami", "powershell ./script.ps1", "node app.mjs", "git branch feature"])
    assert.equal(classifyApproval({ command, cwd: "D:\\Project Codex\\Knots" }, config), "LOCAL_ONLY");
});

test("blocked credential and network tokens win after a safe prefix", () => {
  for (const command of [
    "npm test -- --password=fixture-secret",
    "npm test -- token=fixture-secret",
    "npm test -- ping example.test",
    "npm test -- nslookup example.test",
  ]) assert.equal(classifyApproval({ command, cwd: "D:\\Project Codex\\Knots" }, config), "LOCAL_ONLY", command);
});

test("strict tool parsing rejects response files and hidden path channels", () => {
  for (const command of [
    "node --test @args.txt",
    "node --test tests/a.test.mjs,C:\\outside\\x.test.mjs",
    "node --test file.mjs:secret-stream",
    "node --test \\\\.\\CON",
    "node --test CON",
    "node --test --test-name-pattern=..\\outside",
    "node --test tests,@..\\outside.test.mjs",
  ]) assert.equal(classifyApproval({ command, cwd: "D:\\Project Codex\\Knots" }, config), "LOCAL_ONLY", command);
});

test("fails closed when physical paths are missing or unreadable", () => {
  const throwing = { allowedWorkspaceRoots: ["D:\\Project Codex"], realpathSync: () => { throw new Error("missing"); } };
  assert.equal(classifyApproval({ command: "npm test", cwd: "D:\\Project Codex\\Knots" }, throwing), "LOCAL_ONLY");
});

test("denies a junction cwd that physically resolves outside the trusted root", (t) => {
  const base = mkdtempSync(join(tmpdir(), "hermes-policy-physical-"));
  const root = join(base, "trusted");
  const outside = join(base, "outside");
  const junction = join(root, "junction");
  mkdirSync(root);
  mkdirSync(outside);
  try {
    symlinkSync(outside, junction, "junction");
  } catch (error) {
    rmSync(base, { recursive: true, force: true });
    if (["EPERM", "EACCES"].includes(error?.code)) return t.skip("junction creation unavailable");
    throw error;
  }
  try {
    assert.equal(classifyApproval({ command: "npm test", cwd: junction }, { allowedWorkspaceRoots: [root] }), "LOCAL_ONLY");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("pytest rejects every option outside its explicit allowlist", () => {
  for (const command of ["pytest --pastebin=all", "pytest -x", "python -m pytest --collect-only", "pytest --evil.py"])
    assert.equal(classifyApproval({ command, cwd: "D:\\Project Codex\\Knots" }, config), "LOCAL_ONLY", command);
});

test("path-bearing arguments must exist at classification time", () => {
  const missing = {
    allowedWorkspaceRoots: ["D:\\Project Codex"],
    realpathSync: (path) => {
      if (path.toLowerCase().includes("missing")) throw new Error("missing");
      return path;
    },
  };
  for (const command of [
    "node --test missing.test.mjs",
    "node --check missing.mjs",
    "pytest missing",
    "python -m unittest missing.py",
    "python -m compileall missing",
    "dotnet test missing.csproj",
  ]) assert.equal(classifyApproval({ command, cwd: "D:\\Project Codex\\Knots" }, missing), "LOCAL_ONLY", command);
});

test("path-bearing arguments cannot resolve through a junction outside a trusted root", (t) => {
  const base = mkdtempSync(join(tmpdir(), "hermes-policy-arguments-"));
  const root = join(base, "trusted");
  const outside = join(base, "outside");
  const junction = join(root, "junction");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "test.mjs"), "export {};");
  writeFileSync(join(outside, "test.py"), "pass");
  writeFileSync(join(outside, "test.csproj"), "<Project />");
  try {
    symlinkSync(outside, junction, "junction");
  } catch (error) {
    rmSync(base, { recursive: true, force: true });
    if (["EPERM", "EACCES"].includes(error?.code)) return t.skip("junction creation unavailable");
    throw error;
  }
  try {
    for (const command of [
      "node --test junction\\test.mjs",
      "node --check junction\\test.mjs",
      "pytest junction",
      "python -m pytest junction",
      "python -m unittest junction\\test.py",
      "python -m compileall junction",
      "dotnet test junction\\test.csproj",
    ]) assert.equal(classifyApproval({ command, cwd: root }, { allowedWorkspaceRoots: [root] }), "LOCAL_ONLY", command);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("package-manager test paths cannot resolve through a junction outside a trusted root", (t) => {
  const base = mkdtempSync(join(tmpdir(), "hermes-policy-package-paths-"));
  const root = join(base, "trusted");
  const outside = join(base, "outside");
  const junction = join(root, "junction");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "test.mjs"), "export {};");
  try {
    symlinkSync(outside, junction, "junction");
  } catch (error) {
    rmSync(base, { recursive: true, force: true });
    if (["EPERM", "EACCES"].includes(error?.code)) return t.skip("junction creation unavailable");
    throw error;
  }
  try {
    for (const tool of ["npm", "pnpm", "yarn"]) {
      const command = `${tool} test -- junction\\test.mjs`;
      assert.equal(classifyApproval({ command, cwd: root }, { allowedWorkspaceRoots: [root] }), "LOCAL_ONLY", command);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
