[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = [IO.Path]::GetFullPath((Join-Path $tempBase ("hermes-native-router-e2e-{0}" -f [Guid]::NewGuid().ToString('N'))))
$ownedProcess = $null

if (-not $tempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'E2E_TEMP_BOUNDARY' }
if ($tempRoot.StartsWith(([IO.Path]::GetFullPath($repoRoot) + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) { throw 'E2E_REAL_ROOT' }

$helperSource = @'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repo = process.env.HC3_E2E_REPO;
const root = process.env.HC3_E2E_ROOT;
const queueRoot = join(root, "queue", "bridge", "v3");
const stateRoot = join(root, "state");
const cliPath = join(repo, "bridge", "src", "ui-router-cli.mjs");
const { createReplyDispatcher } = await import(pathToFileURL(join(repo, "bridge", "src", "reply-dispatcher.mjs")).href);
const { createUiActionStore } = await import(pathToFileURL(join(repo, "bridge", "src", "ui-action-store.mjs")).href);
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const ids = {
  first: "evt_a19f74b5-c168-7381-9629-d395da0255f7",
  busy: "evt_b19f74b5-c168-7381-9629-d395da0255f7",
  approval: "evt_c19f74b5-c168-7381-9629-d395da0255f7",
};

await mkdir(join(queueRoot, "interactions"), { recursive: true });
await mkdir(stateRoot, { recursive: true });

async function interaction(id, { kind = "FINAL_RESPONSE", replyMode, action = "REPLY", text = "Telegram text" } = {}) {
  const directory = join(queueRoot, "interactions", id);
  await mkdir(directory, { recursive: true });
  const created = new Date(Date.now() - 60_000);
  const event = {
    schema: "hermes-codex-interaction-event/v3",
    event_id: id,
    kind,
    created_at: created.toISOString(),
    expires_at: new Date(created.getTime() + (kind === "APPROVAL_REQUEST" ? 3_600_000 : 604_800_000)).toISOString(),
    thread: { id: `thread-${id[4]}`, turn_id: `source-${id[4]}`, title: "E2E", project_label: "Sandbox", cwd_label: "Sandbox" },
    message: { summary: "safe", markdown_path: null, is_replyable: true, ...(replyMode === undefined ? {} : { reply_mode: replyMode }) },
    allowed_actions: kind === "APPROVAL_REQUEST" ? ["APPROVE_ONCE", "DECLINE"] : ["REPLY"],
    integrity: { producer: "native-e2e", content_sha256: sha("safe") },
  };
  const reply = {
    schema: "hermes-codex-interaction-reply/v3",
    event_id: id,
    created_at: new Date().toISOString(),
    action,
    text: action === "REPLY" ? text : null,
    telegram: { delivery_ref: `tgmsg-${id[4]}`, sender_fingerprint: "a".repeat(64) },
  };
  await writeFile(join(directory, "event.json"), `${JSON.stringify(event)}\n`, "utf8");
  await writeFile(join(directory, "reply.json"), `${JSON.stringify(reply)}\n`, "utf8");
  return directory;
}

const firstDirectory = await interaction(ids.first, { text: "first native reply" });
const busyDirectory = await interaction(ids.busy, { kind: "QUESTION", replyMode: "NEXT_TURN", text: "busy then idle" });
const approvalDirectory = await interaction(ids.approval, { kind: "APPROVAL_REQUEST", action: "APPROVE_ONCE" });
const uiActionStore = createUiActionStore({ queueRoot });
let approvals = 0;
let externalStarts = 0;
const dispatcher = createReplyDispatcher({
  queueRoot,
  stateRoot,
  uiActionStore,
  replyGuard: { isReplyCurrent: async () => true },
  threadDriver: {
    reply: async () => { externalStarts += 1; },
    resolveInteraction: async () => { approvals += 1; },
  },
});
const firstScan = await dispatcher.scanOnce();
assert.equal(firstScan.routed, 2);
assert.equal(firstScan.applied, 1);
assert.equal(externalStarts, 0);
assert.equal(approvals, 1);

function cli(...args) {
  const child = spawnSync(process.execPath, [cliPath, ...args, "--queue", queueRoot], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  if (child.status !== 0) throw new Error(`CLI_${child.status}:${child.stderr}`);
  return JSON.parse(child.stdout);
}

const listed = cli("list");
assert.equal(listed.actions.length, 2);
const delivered = new Map();
const firstClaim = cli("claim", ids.first);
delivered.set(ids.first, firstClaim.prompt);
assert.match(firstClaim.actionCreatedAt, /^\d{4}-\d{2}-\d{2}T/u);
assert.match(firstClaim.prompt, new RegExp(`HC3_UI_EVENT:${ids.first}`, "u"));
assert.deepEqual(cli("applied", ids.first, firstClaim.leaseId, "visible-first"), { state: "APPLIED" });

const busyClaim = cli("claim", ids.busy);
assert.deepEqual(cli("release", ids.busy, busyClaim.leaseId, "BUSY"), { state: "READY" });
const idleClaim = cli("claim", ids.busy);
delivered.set(ids.busy, idleClaim.prompt);
assert.deepEqual(cli("applied", ids.busy, idleClaim.leaseId, "visible-busy"), { state: "APPLIED" });
assert.deepEqual(cli("list"), { actions: [] });

const secondScan = await dispatcher.scanOnce();
assert.equal(secondScan.routed, 0);
assert.equal(delivered.size, 2);
for (const directory of [firstDirectory, busyDirectory]) {
  assert.equal(JSON.parse(await readFile(join(directory, "receipt.json"), "utf8")).status, "APPLIED");
  await readFile(join(directory, "ui-applied.json"), "utf8");
}
await assert.rejects(readFile(join(approvalDirectory, "ui-action.json"), "utf8"), { code: "ENOENT" });
assert.equal(JSON.parse(await readFile(join(approvalDirectory, "receipt.json"), "utf8")).status, "APPLIED");
await dispatcher.close();

process.stdout.write(`${JSON.stringify({ actions: delivered.size, applied: 2, duplicates: externalStarts, approvalsUnchanged: approvals === 1 })}\n`);
'@

try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  $helperPath = Join-Path $tempRoot 'native-router-e2e.mjs'
  Set-Content -LiteralPath $helperPath -Value $helperSource -Encoding utf8

  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $node
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  [void]$start.ArgumentList.Add($helperPath)
  $start.Environment['HC3_E2E_REPO'] = $repoRoot
  $start.Environment['HC3_E2E_ROOT'] = $tempRoot
  $ownedProcess = [Diagnostics.Process]::new()
  $ownedProcess.StartInfo = $start
  if (-not $ownedProcess.Start()) { throw 'E2E_PROCESS_START' }
  if (-not $ownedProcess.WaitForExit(30000)) {
    $ownedProcess.Kill($true)
    throw 'E2E_TIMEOUT'
  }
  $stdout = $ownedProcess.StandardOutput.ReadToEnd()
  $stderr = $ownedProcess.StandardError.ReadToEnd()
  if ($ownedProcess.ExitCode -ne 0) { throw "E2E_NODE_FAILED:$($ownedProcess.ExitCode):$stderr" }
  $result = $stdout | ConvertFrom-Json
  if ($result.actions -ne 2 -or $result.applied -ne 2 -or $result.duplicates -ne 0 -or $result.approvalsUnchanged -ne $true) { throw 'E2E_ASSERTION' }

  Write-Output 'NATIVE_UI_ROUTER_E2E=PASS'
  Write-Output 'actions=2'
  Write-Output 'applied=2'
  Write-Output 'duplicates=0'
  Write-Output 'approvals_unchanged=yes'
  Write-Output 'real_queue_touched=no'
} finally {
  if ($ownedProcess -and -not $ownedProcess.HasExited) { $ownedProcess.Kill($true) }
  if (Test-Path -LiteralPath $tempRoot) {
    $verified = [IO.Path]::GetFullPath($tempRoot)
    if (-not $verified.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($verified)).StartsWith('hermes-native-router-e2e-', [StringComparison]::Ordinal)) { throw 'E2E_CLEANUP_BOUNDARY' }
    Remove-Item -LiteralPath $verified -Recurse -Force
  }
}
