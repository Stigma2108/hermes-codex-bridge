import { execFile as execFileChild } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

function fail(code) { const error = new Error(code); error.code = code; return error; }

async function discoverCandidates({ configured, localAppData }) {
  const candidates = [configured];
  if (typeof localAppData !== "string" || !isAbsolute(localAppData)) return candidates;
  const root = join(localAppData, "OpenAI", "Codex", "bin");
  let entries = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return candidates; }
  for (const entry of entries) {
    if (entry.isDirectory() && /^[0-9a-f]{16,64}$/iu.test(entry.name)) candidates.push(join(root, entry.name, "codex.exe"));
  }
  return candidates;
}

async function inspectCandidate(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail("CODEX_COMMAND_PATH");
  return realpath(path);
}

function probeCandidate(path, execFile = execFileChild) {
  return new Promise((resolve, reject) => {
    execFile(path, ["--version"], { windowsHide: true, shell: false, timeout: 3_000, maxBuffer: 1024, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(fail("CODEX_COMMAND_VERSION")); else resolve(String(stdout).trim());
    });
  });
}

function parseVersion(text) {
  const match = /^codex-cli\s+(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(text);
  if (!match) throw fail("CODEX_COMMAND_VERSION");
  return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split(".") ?? null };
}

function compareIdentifiers(left, right) {
  const numericLeft = /^\d+$/u.test(left); const numericRight = /^\d+$/u.test(right);
  if (numericLeft && numericRight) return Number(left) - Number(right);
  if (numericLeft !== numericRight) return numericLeft ? -1 : 1;
  return left.localeCompare(right, "en");
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  if (left.prerelease === null || right.prerelease === null) return left.prerelease === right.prerelease ? 0 : (left.prerelease === null ? 1 : -1);
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    if (left.prerelease[index] === undefined || right.prerelease[index] === undefined) return left.prerelease[index] === undefined ? -1 : 1;
    const compared = compareIdentifiers(left.prerelease[index], right.prerelease[index]); if (compared !== 0) return compared;
  }
  return 0;
}

export async function resolveCodexCommand({
  configured,
  localAppData,
  discover = discoverCandidates,
  inspect = inspectCandidate,
  probeVersion = probeCandidate,
} = {}) {
  if (typeof configured !== "string" || !isAbsolute(configured)) throw fail("CODEX_COMMAND_INPUT");
  if (basename(configured).toLowerCase() !== "codex.exe") return configured;
  const candidates = await discover({ configured, localAppData });
  let selected = null;
  const seen = new Set();
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !isAbsolute(candidate) || seen.has(candidate.toLowerCase())) continue;
    seen.add(candidate.toLowerCase());
    try {
      const inspected = await inspect(candidate);
      const physical = typeof inspected === "string" ? inspected : candidate;
      const version = parseVersion(await probeVersion(physical));
      if (!selected || compareVersions(version, selected.version) > 0) selected = { path: physical, version };
    } catch {}
  }
  if (!selected) throw fail("CODEX_COMMAND_VERSION");
  return selected.path;
}
