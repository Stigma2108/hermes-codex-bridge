import { realpathSync as nativeRealpathSync } from "node:fs";
import { win32 } from "node:path";

const LOCAL_ONLY = "LOCAL_ONLY";
const REMOTE_ALLOWED = "REMOTE_ALLOWED";

const BLOCKED_PATTERNS = [
  /\b(?:remove-item|rm|rmdir|rd|del|erase|move-item|move|mv|rename-item|ren)\b/iu,
  /\bgit\s+(?:push|clean|reset\s+--hard)\b/iu,
  /\b(?:publish|release|deploy)\b/iu,
  /\b(?:systemctl|service|sc(?:\.exe)?|reg(?:\.exe)?|regedit|schtasks|netsh|bcdedit|dism|set-executionpolicy|new-service|stop-service|start-service)\b/iu,
  /\b(?:firewall|antivirus|defender|security-policy|network-policy)\b/iu,
  /(?:^|[\\/])\.ssh(?:[\\/]|$)|(?:^|[\\/])\.aws[\\/]credentials(?:$|\s)|\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\bauth\.json\b/iu,
  /\b(?:ssh|scp|sftp|curl|wget|invoke-webrequest|invoke-restmethod|irm|iwr|ftp|telnet|nc|ncat|ping|nslookup|tracert|ipconfig|route|arp)\b/iu,
  /\b(?:send-email|send-message|post-message|charge-payment|make-payment|transfer-funds)\b/iu,
  /(?:^|[^A-Za-z0-9_])(?:access[_-]?token|api[_-]?key|password|passphrase|secret(?:[_-]?key)?|private[_-]?key|credentials?|client[_-]?secret)\s*[:=]/iu,
  /https?:\/\//iu,
];

const SHELL_SYNTAX = /[;&|><`"'\r\n]|\$\(|\^|%[^%]+%|\$env:|\$\{|\$[A-Za-z_][A-Za-z0-9_]*/u;
const ABSOLUTE_OR_HOME_PATH = /(?:^|[\s=:,@])(?:[A-Za-z]:[\\/]|\\\\|~[\\/])/u;
const TRAVERSAL = /(?:^|[\s\\/=,@])\.\.(?=$|[\s\\/,])/u;
const DEVICE_PATH = /(?:^|[\s\\/])(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.[^\s\\/]*)?(?=$|[\s\\/])/iu;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidAbsoluteWindowsPath(value) {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim() && !value.includes("\0") && win32.isAbsolute(value);
}

function isInside(root, cwd) {
  const relative = win32.relative(root.toLowerCase(), cwd.toLowerCase());
  return relative === "" || (!relative.startsWith("..\\") && relative !== ".." && !win32.isAbsolute(relative));
}

function isApproveOnce(request) {
  for (const flag of ["forSession", "persistent"]) {
    if (Object.hasOwn(request, flag) && request[flag] !== false) return false;
  }
  for (const field of ["action", "decision"]) {
    if (!Object.hasOwn(request, field)) continue;
    if (typeof request[field] !== "string") return false;
    if (request[field].trim().toUpperCase().replace(/[\s-]+/gu, "_") !== "APPROVE_ONCE") return false;
  }
  return true;
}

function isSafePathToken(token) {
  return /^[A-Za-z0-9_.\/\\+=~-]+$/u.test(token) && !token.includes(":") && !token.includes(",") && !token.startsWith("@");
}

function classifySafeTestArguments(tokens) {
  const allowedFlags = new Set(["--runInBand", "--coverage", "--watch=false", "--passWithNoTests"]);
  const paths = [];
  for (const token of tokens) {
    if (allowedFlags.has(token)) continue;
    if (!isSafePathToken(token) || !/(?:^|[\\/])[^\\/]+\.(?:[cm]?js|tsx?|jsx?)$/iu.test(token)) return null;
    paths.push(token);
  }
  return paths;
}

function classifySafeInvocation(command) {
  const tokens = command.split(/ +/u);
  const [tool, action] = tokens;
  const lowerTool = tool.toLowerCase();
  const lowerAction = action?.toLowerCase();

  // These commands execute code from an explicitly configured trusted workspace.
  // This is an approval boundary, not a sandbox for arbitrary project code.
  if (["npm", "pnpm", "yarn"].includes(lowerTool)) {
    const directScripts = new Set(["test", "lint", "check", "build"]);
    if (lowerTool === "npm" && lowerAction !== "test" && lowerAction !== "run") return null;
    if (lowerAction === "run") return tokens.length === 3 && directScripts.has(tokens[2]?.toLowerCase()) ? [] : null;
    if (!directScripts.has(lowerAction)) return null;
    if (tokens.length === 2) return [];
    if (lowerAction !== "test" || tokens[2] !== "--") return null;
    return classifySafeTestArguments(tokens.slice(3));
  }

  if (lowerTool === "node") {
    if (lowerAction === "--check") return tokens.length === 3 && isSafePathToken(tokens[2]) && /\.[cm]?js$/iu.test(tokens[2]) ? [tokens[2]] : null;
    if (lowerAction !== "--test") return null;
    const paths = [];
    for (const token of tokens.slice(2)) {
      if (/^--test-(?:concurrency=\d+|name-pattern=[A-Za-z0-9_.+*?~-]+|reporter=(?:spec|tap|dot|junit|lcov))$/u.test(token)) continue;
      if (!isSafePathToken(token) || !/\.(?:[cm]?js|tsx?|jsx?)$/iu.test(token)) return null;
      paths.push(token);
    }
    return paths;
  }

  if (lowerTool === "python" || lowerTool === "py") {
    if (tokens[1] !== "-m" || !["pytest", "unittest", "compileall"].includes(tokens[2]?.toLowerCase())) return null;
    const paths = [];
    for (const token of tokens.slice(3)) {
      if (["-q", "-v", "--disable-warnings"].includes(token) || /^--maxfail=\d+$/u.test(token)) continue;
      if (token.startsWith("-") || !isSafePathToken(token)) return null;
      paths.push(token);
    }
    return paths;
  }
  if (lowerTool === "pytest") {
    const paths = [];
    for (const token of tokens.slice(1)) {
      if (["-q", "-v", "--disable-warnings"].includes(token) || /^--maxfail=\d+$/u.test(token)) continue;
      if (token.startsWith("-") || !isSafePathToken(token)) return null;
      paths.push(token);
    }
    return paths;
  }
  if (lowerTool === "dotnet" && ["test", "build"].includes(lowerAction)) {
    const paths = [];
    for (let index = 2; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (["--no-restore", "--no-build"].includes(token)) continue;
      if (token === "--configuration" && /^(?:Debug|Release)$/u.test(tokens[index + 1] ?? "")) { index += 1; continue; }
      if (!isSafePathToken(token) || !/\.(?:sln|csproj)$/iu.test(token)) return null;
      paths.push(token);
    }
    return paths;
  }
  if (lowerTool === "cargo" && ["test", "check", "build"].includes(lowerAction)) return tokens.slice(2).every((token) => ["--release", "--locked", "--all-targets", "--workspace"].includes(token)) ? [] : null;
  if (/^get-location$/iu.test(command)) return [];
  if (/^git\s+status(?:\s+(?:--short|--branch|--porcelain(?:=v[12])?|-s|-b|-sb))*$/iu.test(command)) return [];
  if (/^git\s+diff(?:\s+(?:--stat|--cached|--check|--name-only|--name-status|HEAD(?:~\d+)?))*$/iu.test(command)) return [];
  if (/^git\s+log(?:\s+(?:--oneline|--stat|--decorate|--graph|-\d+|--max-count=\d+))*$/iu.test(command)) return [];
  return null;
}

export function classifyApproval(request, config) {
  try {
    if (!isRecord(request) || !isRecord(config) || !Array.isArray(config.allowedWorkspaceRoots)) return LOCAL_ONLY;
    if (config.allowedWorkspaceRoots.length === 0 || !config.allowedWorkspaceRoots.every(isValidAbsoluteWindowsPath)) return LOCAL_ONLY;
    if (!isValidAbsoluteWindowsPath(request.cwd) || typeof request.command !== "string" || !isApproveOnce(request)) return LOCAL_ONLY;

    const roots = config.allowedWorkspaceRoots.map((root) => win32.resolve(root));
    const cwd = win32.resolve(request.cwd);
    if (!roots.some((root) => isInside(root, cwd))) return LOCAL_ONLY;
    const protectedRoots = [config.queueRoot, config.codexHome, config.stateRoot]
      .filter(isValidAbsoluteWindowsPath)
      .map((root) => win32.resolve(root));
    if (protectedRoots.some((root) => isInside(root, cwd))) return LOCAL_ONLY;

    // Resolve immediately before the decision. The caller must revalidate at execution time;
    // this classifier cannot eliminate the filesystem TOCTOU window.
    const realpath = typeof config.realpathSync === "function" ? config.realpathSync : nativeRealpathSync;
    const physicalRoots = roots.map((root) => win32.resolve(realpath(root)));
    const physicalCwd = win32.resolve(realpath(cwd));
    if (!physicalRoots.some((root) => isInside(root, physicalCwd))) return LOCAL_ONLY;
    const physicalProtectedRoots = protectedRoots.map((root) => win32.resolve(realpath(root)));
    if (physicalProtectedRoots.some((root) => isInside(root, physicalCwd))) return LOCAL_ONLY;

    const command = request.command.trim();
    if (command.length === 0 || command !== request.command) return LOCAL_ONLY;
    if (SHELL_SYNTAX.test(command) || ABSOLUTE_OR_HOME_PATH.test(command) || TRAVERSAL.test(command) || DEVICE_PATH.test(command)) return LOCAL_ONLY;
    if (command.includes(",") || /(?:^|\s)@/u.test(command) || BLOCKED_PATTERNS.some((pattern) => pattern.test(command))) return LOCAL_ONLY;
    const pathArguments = classifySafeInvocation(command);
    if (pathArguments === null) return LOCAL_ONLY;
    for (const argument of pathArguments) {
      const lexicalPath = win32.resolve(cwd, argument);
      if (!roots.some((root) => isInside(root, lexicalPath))) return LOCAL_ONLY;
      if (protectedRoots.some((root) => isInside(root, lexicalPath))) return LOCAL_ONLY;
      const physicalPath = win32.resolve(realpath(lexicalPath));
      if (!physicalRoots.some((root) => isInside(root, physicalPath))) return LOCAL_ONLY;
      if (physicalProtectedRoots.some((root) => isInside(root, physicalPath))) return LOCAL_ONLY;
    }
    return REMOTE_ALLOWED;
  } catch {
    return LOCAL_ONLY;
  }
}
