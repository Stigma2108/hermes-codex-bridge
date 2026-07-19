import { spawn as spawnChild } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SCRIPT = fileURLToPath(new URL("../scripts/Get-WindowsPresence.ps1", import.meta.url));
const MAX_OUTPUT_BYTES = 4 * 1024;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function runPowerShellProbe({
  scriptPath = DEFAULT_SCRIPT,
  spawn = spawnChild,
  timeoutMs = 3_000,
} = {}) {
  if (typeof scriptPath !== "string" || !isAbsolute(scriptPath) || typeof spawn !== "function" ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    return Promise.reject(failure("PRESENCE_INPUT"));
  }
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let output = Buffer.alloc(0);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    try {
      child = spawn("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", scriptPath], {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      reject(failure("PRESENCE_SPAWN"));
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(failure("PRESENCE_TIMEOUT"));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      output = Buffer.concat([output, Buffer.from(chunk)]);
      if (output.length > MAX_OUTPUT_BYTES) {
        try { child.kill(); } catch {}
        finish(failure("PRESENCE_OUTPUT"));
      }
    });
    child.once("error", () => finish(failure("PRESENCE_SPAWN")));
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null || output.length === 0) {
        finish(failure("PRESENCE_EXIT"));
        return;
      }
      finish(null, output.toString("utf8").trim());
    });
  });
}

export function createWindowsPresenceProbe({ run = runPowerShellProbe, scriptPath = DEFAULT_SCRIPT } = {}) {
  if (typeof run !== "function" || typeof scriptPath !== "string" || !isAbsolute(scriptPath)) throw failure("PRESENCE_INPUT");
  return {
    async sample({ awayIdleMs = 90_000 } = {}) {
      if (!Number.isSafeInteger(awayIdleMs) || awayIdleMs < 1) return { state: "UNKNOWN", idleMs: null };
      try {
        const value = JSON.parse(await run({ scriptPath }));
        if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.locked !== "boolean" ||
            !Number.isSafeInteger(value.idleMs) || value.idleMs < 0) {
          throw failure("PRESENCE_OUTPUT");
        }
        return { state: value.locked || value.idleMs >= awayIdleMs ? "AWAY" : "DESK", idleMs: value.idleMs };
      } catch {
        return { state: "UNKNOWN", idleMs: null };
      }
    },
  };
}
