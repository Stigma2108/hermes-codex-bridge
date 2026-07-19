const REDACTED = "[REDACTED]";
const MAX_INPUT_CODE_UNITS = 1024 * 1024;

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function redactPemBlocks(value) {
  const marker = "-----BEGIN ";
  let cursor = 0;
  let output = "";
  while (cursor < value.length) {
    const begin = value.indexOf(marker, cursor);
    if (begin === -1) return output + value.slice(cursor);
    const lineEnd = value.indexOf("\n", begin);
    const beginEnd = lineEnd === -1 ? value.length : lineEnd;
    const beginLine = value.slice(begin, beginEnd).replace(/\r$/u, "");
    if (!/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----$/u.test(beginLine)) {
      output += value.slice(cursor, begin + marker.length);
      cursor = begin + marker.length;
      continue;
    }

    output += value.slice(cursor, begin);
    const label = beginLine.slice("-----BEGIN ".length, -"-----".length);
    const endLine = `-----END ${label}-----`;
    const end = value.indexOf(endLine, beginEnd);
    if (end === -1) return `${output}${beginLine}\n${REDACTED}`;
    output += `${beginLine}\n${REDACTED}\n${endLine}`;
    cursor = end + endLine.length;
  }
  return output;
}

function redactHeaders(value) {
  return value.replace(/[^\r\n]*(?:\r\n|\n|\r|$)/gu, (line) => {
    const newline = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") || line.endsWith("\r") ? line.at(-1) : "";
    const body = newline === "\r\n" ? line.slice(0, -2) : newline.length === 1 ? line.slice(0, -1) : line;
    const authorization = /^(\s*authorization\s*:\s*)(?:bearer|basic)\b/iu.exec(body);
    if (authorization) return `${authorization[1]}${REDACTED}${newline}`;
    const apiKey = /^(\s*x-api-key\s*:\s*)/iu.exec(body);
    if (apiKey) return `${apiKey[1]}${REDACTED}${newline}`;
    return line;
  });
}

function redactUrlUserinfo(value) {
  const scheme = /\b[a-z][a-z0-9+.-]*:\/\//giu;
  let cursor = 0;
  let output = "";
  for (let match = scheme.exec(value); match !== null; match = scheme.exec(value)) {
    const authorityStart = match.index + match[0].length;
    let authorityEnd = authorityStart;
    while (authorityEnd < value.length && !/[/?#\s]/u.test(value[authorityEnd])) authorityEnd += 1;
    const authority = value.slice(authorityStart, authorityEnd);
    scheme.lastIndex = authorityEnd;
    const at = authority.lastIndexOf("@");
    if (at === -1) continue;
    output += value.slice(cursor, authorityStart) + REDACTED + authority.slice(at);
    cursor = authorityEnd;
  }
  return output + value.slice(cursor);
}

function isSensitiveName(rawName) {
  let name = rawName.toLowerCase().replaceAll("-", "_");
  if (name.startsWith("$env:")) name = name.slice(5);
  if (name.startsWith("env.")) name = name.slice(4);
  if (name === "authorization") return true;
  const parts = name.split(/[_.]/u).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    if (["token", "password", "passphrase", "secret", "credential", "credentials"].includes(parts[index])) return true;
    const pair = `${parts[index]}_${parts[index + 1] ?? ""}`;
    if (["access_token", "api_key", "secret_key", "private_key", "client_secret"].includes(pair)) return true;
  }
  return false;
}

function readQuoted(value, start, quote) {
  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
      continue;
    }
    if (value[index] === quote) return index;
  }
  return -1;
}

function redactAssignments(value) {
  let cursor = 0;
  let output = "";
  while (cursor < value.length) {
    let keyStart = cursor;
    let keyEnd;
    let rawName;
    let quotedKey = false;
    if (value[keyStart] === '"' || value[keyStart] === "'") {
      quotedKey = true;
      const quote = value[keyStart];
      let close = -1;
      const keyLimit = Math.min(value.length, keyStart + 130);
      for (let index = keyStart + 1; index < keyLimit; index += 1) {
        if (value[index] === "\\") break;
        if (value[index] === quote) { close = index; break; }
      }
      if (close === -1) {
        output += value[keyStart];
        cursor += 1;
        continue;
      }
      rawName = value.slice(keyStart + 1, close);
      keyEnd = close + 1;
    } else {
      const previous = keyStart === 0 ? "" : value[keyStart - 1];
      if (/[A-Za-z0-9_]/u.test(previous) || !/[$A-Za-z_]/u.test(value[keyStart])) {
        output += value[keyStart];
        cursor += 1;
        continue;
      }
      keyEnd = keyStart + 1;
      if (value.startsWith("$env:", keyStart)) keyEnd = keyStart + 5;
      while (keyEnd < value.length && /[A-Za-z0-9_.-]/u.test(value[keyEnd])) keyEnd += 1;
      rawName = value.slice(keyStart, keyEnd);
    }

    let delimiter = keyEnd;
    while (delimiter < value.length && /[ \t]/u.test(value[delimiter])) delimiter += 1;
    if (!isSensitiveName(rawName) || (value[delimiter] !== "=" && value[delimiter] !== ":")) {
      output += value[keyStart];
      cursor += 1;
      continue;
    }
    let valueStart = delimiter + 1;
    while (valueStart < value.length && /[ \t]/u.test(value[valueStart])) valueStart += 1;
    output += value.slice(keyStart, valueStart);
    if (value.startsWith(REDACTED, valueStart)) {
      output += REDACTED;
      cursor = valueStart + REDACTED.length;
      continue;
    }
    const quote = value[valueStart];
    if (quote === '"' || quote === "'") {
      const close = readQuoted(value, valueStart, quote);
      if (close === -1) return `${output}${quote}${REDACTED}${quote}`;
      output += `${quote}${REDACTED}${quote}`;
      cursor = close + 1;
    } else {
      let end = valueStart;
      const terminator = quotedKey ? /[\r\n,;}\]&?#]/u : /[\r\n&?#]/u;
      while (end < value.length && !terminator.test(value[end])) end += 1;
      const trailing = /\s*$/u.exec(value.slice(valueStart, end))?.[0] ?? "";
      output += REDACTED + trailing;
      cursor = end;
    }
  }
  return output;
}

function redactQueryParameters(value) {
  const sensitive = new Set(["token", "access_token", "api_key", "password", "passphrase", "secret", "secret_key", "private_key", "credential", "credentials", "client_secret", "signature", "sig", "x_amz_signature"]);
  return value.replace(/([?&])([^?&#=\s]+)=([^&#\s]*)/gu, (match, separator, key) => {
    const normalized = key.toLowerCase().replaceAll("-", "_");
    return sensitive.has(normalized) ? `${separator}${key}=${REDACTED}` : match;
  });
}

function redactTokenFamilies(value) {
  const telegram = String.raw`\d{6,12}:[A-Za-z0-9_-]{30,}`;
  const patterns = [
    new RegExp(String.raw`(?<![A-Za-z0-9_-])${telegram}(?![A-Za-z0-9_-])`, "gu"),
    /(?<![A-Za-z0-9_-])xox[a-z]-[A-Za-z0-9-]{20,}(?![A-Za-z0-9_-])/giu,
    /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/gu,
    /(?<![A-Za-z0-9_-])(?:gh[pousr]_[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,})(?![A-Za-z0-9_-])/gu,
    /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/gu,
  ];
  let safe = value;
  safe = safe.replace(new RegExp(String.raw`/bot${telegram}(?=[/?#\s.,;:!\])}]|$)`, "gu"), `/bot${REDACTED}`);
  for (const pattern of patterns) safe = safe.replace(pattern, REDACTED);
  safe = safe.replace(
    /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{4,})\.([A-Za-z0-9_-]{2,})\.([A-Za-z0-9_-]{8,})(?![A-Za-z0-9_-])/gu,
    (candidate, header) => {
      if (!header.startsWith("eyJ")) return candidate;
      try {
        const decoded = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
        if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return candidate;
        if (typeof decoded.alg !== "string" && typeof decoded.typ !== "string") return candidate;
        return REDACTED;
      } catch {
        return candidate;
      }
    },
  );
  return safe;
}

export function toTelegramSafeText(value) {
  if (typeof value !== "string") throw stableError("REDACTION_INPUT");
  if (value.length > MAX_INPUT_CODE_UNITS) throw stableError("REDACTION_TOO_LARGE");
  let safe = redactPemBlocks(value);
  safe = redactHeaders(safe);
  safe = redactUrlUserinfo(safe);
  safe = redactAssignments(safe);
  safe = redactQueryParameters(safe);
  return redactTokenFamilies(safe);
}
