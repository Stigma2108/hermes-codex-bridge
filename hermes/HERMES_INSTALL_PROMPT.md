# Install the Hermes–Codex Bridge on Linux

Use this prompt only on the separately authorized Linux host after the Windows installer payload has converged through Syncthing. Work from the directory containing this file; it must also contain `scripts/install.sh`, `scripts/uninstall.sh`, `templates/`, `watcher.py`, and `doctor.py`.

Begin with a read-only preflight. Verify that the official `hermes` command works, a normal local Hermes chat succeeds, `hermes gateway setup` is complete, and a normal Telegram conversation succeeds. Verify Python 3, systemd, `sudo`, the existing non-root account that runs Hermes, its writable Hermes home, the protected env file with mode `0600`, and read/write/traverse access to the absolute Queue root ending in `Queue/bridge/v3`. Never request a token or chat ID in chat and never print environment values, Queue records, or configured paths.

Run the installer without `--apply` from this directory:

```sh
sudo ./scripts/install.sh --queue-root "<absolute-shared-root>/Queue/bridge/v3" --hermes-home "<absolute-hermes-home>" --env-file "<absolute-protected-env-file>" --service-user hermes
```

Show only the redacted target labels and test plan. Stop on missing authority, unsafe paths, insufficient service-account access, failed Syncthing convergence, invalid env protection, failed tests, or conflicting ownership. Wait for explicit user approval of the unchanged plan before adding `--apply`. Do not reproduce installer steps manually.

After approved installation, run the offline doctor from this directory, check the service, and run the installed tests:

```sh
python3 ./doctor.py --queue-root "<absolute-shared-root>/Queue/bridge/v3" --env-file "<absolute-protected-env-file>" --runtime-root /opt/hermes-codex-bridge-v3
sudo systemctl status hermes-codex-bridge.service --no-pager
sudo -u hermes python3 -m unittest discover -s /opt/hermes-codex-bridge-v3 -p 'test_*.py' -v
```

Return only redacted health codes and test counts. For recovery, preview `./scripts/uninstall.sh` first and obtain separate approval before `--apply`. The uninstall preserves the protected env file by default; use `--remove-env` only after separate explicit approval. Never remove the Queue, Syncthing configuration, Hermes home, Telegram configuration, or unrelated skills.
