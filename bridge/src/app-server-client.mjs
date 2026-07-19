import { spawn as spawnChild } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFile, rename, stat } from "node:fs/promises";

import { toTelegramSafeText } from "./redaction.mjs";

const MAX_LINE = 8 * 1024 * 1024;
function failure(code, message = code) { const error = new Error(message); error.code = code; return error; }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

async function rotateAndAppend(path, text, maxBytes, count) {
  let size = 0; try { size = (await stat(path)).size; } catch {}
  if (size + Buffer.byteLength(text) > maxBytes) {
    for (let index = count - 1; index >= 1; index -= 1) {
      try { await rename(`${path}.${index}`, `${path}.${index + 1}`); } catch {}
    }
    try { await rename(path, `${path}.1`); } catch {}
  }
  await appendFile(path, text, { encoding: "utf8", mode: 0o600 });
}

export class AppServerClient extends EventEmitter {
  static async spawn(command, args = [], options = {}) {
    if (typeof command !== "string" || !Array.isArray(args)) throw failure("APP_SERVER_SPAWN");
    const child = (options.spawn ?? spawnChild)(command, args, {
      cwd: options.cwd, env: options.env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new AppServerClient(child, options);
    await new Promise((resolve, reject) => {
      const onError = (error) => { child.off("spawn", onSpawn); reject(error); };
      const onSpawn = () => { child.off("error", onError); resolve(); };
      child.once("error", onError); child.once("spawn", onSpawn);
    });
    return client;
  }

  constructor(child, options = {}) {
    super(); this.child = child; this.pending = new Map(); this.nextId = 1; this.closed = false; this.closing = null; this.buffer = Buffer.alloc(0); this.fatalError = null;
    this.stderrSink = options.stderrSink; this.stderrLogPath = options.stderrLogPath; this.logMaxBytes = options.logMaxBytes ?? 1024 * 1024; this.logCount = options.logCount ?? 3;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 0;
    child.stdout.on("data", (chunk) => this.#onData(chunk));
    child.stderr.on("data", (chunk) => this.#onStderr(chunk));
    child.once("exit", (code, signal) => this.#terminate(this.fatalError ?? failure("APP_SERVER_EXIT", `APP_SERVER_EXIT:${code ?? signal ?? "unknown"}`)));
    child.once("error", () => this.#terminate(failure("APP_SERVER_EXIT")));
    child.stdin.on("error", () => this.#terminate(failure("APP_SERVER_EXIT")));
  }

  #write(message) {
    if (this.closed || !this.child.stdin.writable) throw this.fatalError ?? failure("APP_SERVER_CLOSED");
    let line; try { line = `${JSON.stringify(message)}\n`; } catch { throw failure("APP_SERVER_SERIALIZE"); }
    if (!this.child.stdin.write(line, "utf8")) this.child.stdin.once("drain", () => {});
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (typeof method !== "string" || !method || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000) return Promise.reject(failure("APP_SERVER_REQUEST"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      const entry = {
        resolve: (value) => { if (timer) clearTimeout(timer); resolve(value); },
        reject: (error) => { if (timer) clearTimeout(timer); reject(error); },
      };
      this.pending.set(id, entry);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(failure("APP_SERVER_TIMEOUT"));
        }, timeoutMs);
        timer.unref?.();
      }
      try { this.#write({ id, method, params }); } catch (error) { this.pending.delete(id); entry.reject(error); }
    });
  }

  async notify(method, params = {}) { this.#write({ method, params }); }
  respond(id, result) { this.#write({ id, result }); }
  respondError(id, code, message) { this.#write({ id, error: { code, message } }); }

  async initialize(clientInfo) {
    if (!record(clientInfo) || !["name", "title", "version"].every((key) => typeof clientInfo[key] === "string" && clientInfo[key])) throw failure("APP_SERVER_INITIALIZE");
    const result = await this.request("initialize", {
      clientInfo: { name: clientInfo.name, title: clientInfo.title, version: clientInfo.version },
      capabilities: record(clientInfo.capabilities) ? clientInfo.capabilities : {},
    });
    await this.notify("initialized", {}); return result;
  }

  #onData(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) { if (this.buffer.length > MAX_LINE) this.#protocolFailure("APP_SERVER_LINE_TOO_LARGE"); return; }
      if (newline > MAX_LINE) { this.#protocolFailure("APP_SERVER_LINE_TOO_LARGE"); return; }
      const bytes = this.buffer.subarray(0, newline); this.buffer = this.buffer.subarray(newline + 1);
      let line; let message;
      try { line = new TextDecoder("utf-8", { fatal: true }).decode(bytes); message = JSON.parse(line); } catch { this.#protocolFailure("APP_SERVER_PROTOCOL"); return; }
      if (!record(message)) { this.#protocolFailure("APP_SERVER_PROTOCOL"); return; }
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) && !Object.hasOwn(message, "method")) {
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id);
      if (Object.hasOwn(message, "error")) { const error = failure(message.error?.code ?? "APP_SERVER_REMOTE", String(message.error?.message ?? "APP_SERVER_REMOTE")); pending.reject(error); }
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string" && Object.hasOwn(message, "id")) { this.emit("serverRequest", message); this.emit(`serverRequest:${message.method}`, message); return; }
    if (typeof message.method === "string" && !Object.hasOwn(message, "id")) { this.emit("notification", message); this.emit(`notification:${message.method}`, message.params, message); return; }
    this.#protocolFailure("APP_SERVER_PROTOCOL");
  }

  #onStderr(chunk) {
    let safe; try { safe = `${toTelegramSafeText(chunk.toString("utf8").slice(0, 64 * 1024)).trimEnd()}\n`; } catch { safe = "[REDACTED]\n"; }
    if (typeof this.stderrSink === "function") { try { this.stderrSink(safe.trimEnd()); } catch {} }
    if (this.stderrLogPath) void rotateAndAppend(this.stderrLogPath, safe, this.logMaxBytes, this.logCount).catch(() => {});
  }

  #protocolFailure(code) { if (this.closed) return; this.fatalError = failure(code); this.#terminate(this.fatalError); try { this.child.kill(); } catch {} }
  #terminate(error) { if (this.closed) return; this.closed = true; for (const { reject } of this.pending.values()) reject(error); this.pending.clear(); this.emit("closed", error); }

  async close({ timeoutMs = 1000 } = {}) {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        try { this.child.stdin.end(); } catch {}
        await Promise.race([onceExit(this.child), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
        if (this.child.exitCode === null && this.child.signalCode === null) { try { this.child.kill(); } catch {} await Promise.race([onceExit(this.child), new Promise((resolve) => setTimeout(resolve, timeoutMs))]); }
      }
      this.#terminate(this.fatalError ?? failure("APP_SERVER_CLOSED"));
      this.removeAllListeners();
    })();
    return this.closing;
  }
}

function onceExit(child) { return new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", resolve); }); }
