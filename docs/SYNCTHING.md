# Configure Syncthing

Syncthing is the bridge transport, not the bridge authority. Use one narrow folder shared only by the two owned hosts so unrelated personal data, credentials, and application homes never enter the replication boundary.

Primary references: [Getting Started](https://docs.syncthing.net/intro/getting-started.html), [Autostart](https://docs.syncthing.net/users/autostart.html), and [Ignoring Files](https://docs.syncthing.net/users/ignoring.html).

## Prerequisites

- Syncthing installed on Windows and Linux from a source appropriate to each host.
- Administrative or user-service authority for each host separately.
- A trusted channel for device pairing and confirmation of each displayed device identity.
- New, empty absolute roots dedicated to this bridge. Do not choose a home directory, an entire notes vault, Codex home, Hermes home, or an existing broad data tree.

Define these environment-specific placeholders locally immediately before the first command:

- `<WINDOWS_SHARED_ROOT>` — dedicated absolute root on Windows.
- `<LINUX_SHARED_ROOT>` — dedicated absolute root on Linux.
- `<SYNC_NONCE>` — a fresh harmless random label containing no host, user, device, project, or credential information.

Confirm the selected roots locally before configuration:

```powershell
Test-Path -LiteralPath "<WINDOWS_SHARED_ROOT>" -PathType Container
```

```sh
test -d "<LINUX_SHARED_ROOT>"
```

## Device Pairing

1. Open the local Syncthing UI on each host without exposing it publicly or weakening authentication.
2. Exchange device IDs through the trusted channel and approve the expected peer on both sides. Device IDs identify peers but should still be kept out of public reports.
3. Create one folder with the same folder ID on both devices, set both sides to **Send & Receive**, and map it to the two dedicated roots.
4. Share that folder with only the expected Windows and Linux devices.
5. Wait for both devices to show connected and the dedicated folder to show up to date.

A running process or connected peer is not proof of folder convergence.

## Ignore Policy

Create the same `.stignore` at the root on both hosts before the first meaningful sync. Keep the bridge repository files, `Queue/bridge/v3`, `Queue/protocol/v3`, and `v3/windows`/`v3/hermes`. Exclude local development and secret material:

```text
(?d).git
(?d).planning
(?d).env*
(?d)**/.env*
(?d)**/__pycache__
(?d)**/*.pyc
(?d).syncthing.*.tmp
(?d)sync-conflict-*
```

Review the official ignore syntax before adding patterns. If the dedicated root contains any unrelated subtree, stop and move the bridge to a clean root instead of trying to maintain a fragile allowlist. Never place the protected Hermes env file under this folder.

## Autostart

Use the platform-specific mechanisms in the official [Autostart documentation](https://docs.syncthing.net/users/autostart.html). Prefer the documented per-user Windows startup/task method and the Linux user service when it matches the host's ownership model. Confirm the same Syncthing instance and configuration return after logout/restart.

Do not bind the management UI to a public interface, disable GUI authentication, or open firewall access beyond the approved peer path. Relay use and firewall policy are host-owner decisions outside the bridge installer.

## Two-Way Convergence Test

Create a harmless sentinel on Windows, record its SHA-256 locally, and wait for the same name and hash on Linux:

```powershell
Set-Content -LiteralPath "<WINDOWS_SHARED_ROOT>\sync-<SYNC_NONCE>-windows.txt" -Value "<SYNC_NONCE>" -Encoding ascii
Get-FileHash -Algorithm SHA256 -LiteralPath "<WINDOWS_SHARED_ROOT>\sync-<SYNC_NONCE>-windows.txt"
```

```sh
sha256sum "<LINUX_SHARED_ROOT>/sync-<SYNC_NONCE>-windows.txt"
printf '%s\n' '<SYNC_NONCE>' > "<LINUX_SHARED_ROOT>/sync-<SYNC_NONCE>-linux.txt"
sha256sum "<LINUX_SHARED_ROOT>/sync-<SYNC_NONCE>-linux.txt"
```

Wait for the Linux sentinel to reach Windows and compare its hash:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath "<WINDOWS_SHARED_ROOT>\sync-<SYNC_NONCE>-linux.txt"
Remove-Item -LiteralPath "<WINDOWS_SHARED_ROOT>\sync-<SYNC_NONCE>-windows.txt","<WINDOWS_SHARED_ROOT>\sync-<SYNC_NONCE>-linux.txt"
```

Finally prove both deletions converge on Linux. Report only a shortened nonce prefix and pass/fail; do not report device IDs, configured paths, folder inventories, or file content.

## Conflict Handling

If Syncthing creates any `sync-conflict-*` file under bridge-owned paths, stop both bridge services before investigation. Do not choose “newest”, edit a committed Queue record, merge JSON, or rename the conflict into place. A conflict can mean two writers violated ownership or the folder was paired incorrectly.

Preserve the conflicting files privately, compare safe names/sizes/hashes and writer ownership, and run both doctors. Restore service only after the intended single writer and write-once history are established. Queue records are audit evidence.

Synchronization is not a backup. Syncthing propagates deletion and corruption. Back up the repository, configuration, and Queue audit history with a separate versioned system appropriate to your environment.

## Expected Redacted Output

The safe report is a result summary, not raw Syncthing configuration:

```text
SYNCTHING_PEERS_OK
SYNCTHING_FOLDER_UP_TO_DATE
SYNC_WINDOWS_TO_LINUX_OK nonce=<short-prefix>
SYNC_LINUX_TO_WINDOWS_OK nonce=<short-prefix>
SYNC_DELETE_CONVERGED
```

These are operator report labels, not Syncthing CLI output. They are valid only after both hashes and both deletions were observed.

## Failure Behavior

- Missing peer approval, wrong folder mode, an unexpected device, or an ambiguous root stops setup before bridge installation.
- A one-way sentinel or mismatched hash means `SYNCTHING_NOT_CONVERGED`; do not start either bridge installer.
- An ignored protocol/runtime path means the policy is too broad. Correct `.stignore`, rescan, and rerun both sentinels.
- A conflict file stops live delivery until ownership is resolved. Never repair it by publishing Queue payloads or credentials to a support channel.

## Rollback and Recovery

Pause bridge services before changing a live shared folder. Revert only the folder mapping or ignore policy created for this bridge, then prove convergence again. Do not delete Queue history to make a peer appear up to date.

Uninstalling the bridge intentionally preserves the dedicated folder, Syncthing configuration, and synced Queue. Removing or unpairing them is a separate operation requiring separate host-owner approval and a verified backup/recovery plan.
