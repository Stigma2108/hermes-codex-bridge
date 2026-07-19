import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import { openLedger } from "../src/ledger.mjs";

const CHILD_TIMEOUT_MS = 5_000;
const READY_CONTENT = "hermes-ledger-claims-v1\n";
const activeChildren = new Set();
const temporaryDirectories = [];

async function createLedgerPath() {
  const directory = await mkdtemp(join(tmpdir(), "hermes-ledger-"));
  temporaryDirectories.push(directory);
  return join(directory, "state", "dedupe.ledger");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasExactError(code) {
  return (error) => error?.message === code && error?.code === code;
}

function expectedResult(marked) {
  return { marked, ledgerError: null, cleanupError: null };
}

function waitForChildClose(child) {
  if (!activeChildren.has(child)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1_000);
    timeout.unref();
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function launchLedgerChild(path, rawKey, gatePath) {
  const script = `
    import { existsSync } from "node:fs";
    import { openLedger } from ${JSON.stringify(new URL("../src/ledger.mjs", import.meta.url).href)};
    const ledger = await openLedger(process.env.TEST_LEDGER_PATH);
    process.stdout.write("READY\\n");
    while (!existsSync(process.env.TEST_LEDGER_GATE)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const result = await ledger.mark(process.env.TEST_LEDGER_KEY);
    await ledger.close();
    process.stdout.write(\`RESULT:\${JSON.stringify({ marked: result.marked })}\\n\`);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    env: {
      ...process.env,
      TEST_LEDGER_PATH: path,
      TEST_LEDGER_KEY: rawKey,
      TEST_LEDGER_GATE: gatePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChildren.add(child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdout = "";
  let stderr = "";
  let readySettled = false;
  let resolveReady;
  let rejectReady;
  let resolveCompletion;
  let rejectCompletion;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  completion.catch(() => {});

  function fail(error) {
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    rejectCompletion(error);
    if (child.exitCode === null) {
      child.kill();
    }
  }

  const timeout = setTimeout(() => {
    fail(new Error(`child timed out after ${CHILD_TIMEOUT_MS}ms: ${stderr}`));
  }, CHILD_TIMEOUT_MS);
  timeout.unref();

  child.once("error", fail);
  child.once("close", (code) => {
    clearTimeout(timeout);
    activeChildren.delete(child);
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error(`child exited before ready (${code}): ${stderr}`));
    }
    if (code === 0) {
      resolveCompletion(stdout);
    } else {
      rejectCompletion(new Error(`child exited with ${code}: ${stderr}`));
    }
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!readySettled && stdout.includes("READY\n")) {
      readySettled = true;
      resolveReady();
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return { ready, completion };
}

afterEach(async () => {
  const children = [...activeChildren];
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill();
    }
  }
  await Promise.all(children.map(waitForChildClose));
  activeChildren.clear();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("mark is visible through has and remains visible after reopen", async () => {
  const path = await createLedgerPath();
  const rawKey = "thread:turn:item:FINAL_RESPONSE";
  const ledger = await openLedger(path);

  assert.equal(ledger.has(rawKey), false);
  assert.deepEqual(await ledger.mark(rawKey), expectedResult(true));
  assert.equal(ledger.has(rawKey), true);
  await ledger.close();

  const reopened = await openLedger(path);
  assert.equal(reopened.has(rawKey), true);
  assert.deepEqual(await reopened.mark(rawKey), expectedResult(false));
  await reopened.close();
});

test("the ledger and canonical claim contain only the lowercase hash", async () => {
  const path = await createLedgerPath();
  const rawKey = "private-thread-id:private-turn-id:FINAL_RESPONSE";
  const hash = sha256(rawKey);
  const ledger = await openLedger(path);

  await ledger.mark(rawKey);
  await ledger.close();

  assert.equal(await readFile(path, "utf8"), `${hash}\n`);
  assert.equal(await readFile(join(`${path}.claims`, hash), "utf8"), `${hash}\n`);
  assert.equal((await readFile(path, "utf8")).includes(rawKey), false);
});

test("duplicate and concurrent duplicate marks append exactly one line", async () => {
  const path = await createLedgerPath();
  const rawKey = "thread:turn:item:duplicate";
  const ledger = await openLedger(path);

  const results = await Promise.all(Array.from({ length: 20 }, () => ledger.mark(rawKey)));
  await ledger.close();

  assert.equal(results.filter((result) => result.marked).length, 1);
  assert.equal(await readFile(path, "utf8"), `${sha256(rawKey)}\n`);
});

test("independently opened ledgers atomically deduplicate the same key", async () => {
  const path = await createLedgerPath();
  const rawKey = "thread:turn:item:two-instances";
  const first = await openLedger(path);
  const second = await openLedger(path);

  const results = await Promise.all([first.mark(rawKey), second.mark(rawKey)]);
  await Promise.all([first.close(), second.close()]);

  assert.deepEqual(results.map((result) => result.marked).sort(), [false, true]);
  assert.equal(await readFile(path, "utf8"), `${sha256(rawKey)}\n`);
});

test("has observes and validates a claim created by another ledger", async () => {
  const path = await createLedgerPath();
  const rawKey = "thread:turn:item:cross-instance-has";
  const first = await openLedger(path);
  const second = await openLedger(path);

  await first.mark(rawKey);
  assert.equal(second.has(rawKey), true);
  await Promise.all([first.close(), second.close()]);
});

test("independent ledgers append concurrent distinct hashes as complete lines", async () => {
  const path = await createLedgerPath();
  const rawKeys = ["thread:turn:item:first", "thread:turn:item:second"];
  const first = await openLedger(path);
  const second = await openLedger(path);

  const results = await Promise.all([first.mark(rawKeys[0]), second.mark(rawKeys[1])]);
  assert.deepEqual(results.map((result) => result.marked), [true, true]);
  await Promise.all([first.close(), second.close()]);
  assert.deepEqual(
    (await readFile(path, "utf8")).trim().split("\n").sort(),
    rawKeys.map(sha256).sort(),
  );
});

test("independent processes atomically claim one key without raw data", async () => {
  const path = await createLedgerPath();
  const rawKey = "private-thread:private-turn:child-process-race";
  const gatePath = join(dirname(path), "race.gate");
  const first = launchLedgerChild(path, rawKey, gatePath);
  const second = launchLedgerChild(path, rawKey, gatePath);

  await Promise.all([first.ready, second.ready]);
  await writeFile(gatePath, "go");
  const outputs = await Promise.all([first.completion, second.completion]);
  const marked = outputs.map((output) =>
    JSON.parse(output.match(/RESULT:(\{.*\})/)?.[1]).marked,
  );

  assert.deepEqual(marked.sort(), [false, true]);
  const hash = sha256(rawKey);
  assert.equal(await readFile(path, "utf8"), `${hash}\n`);
  assert.equal(await readFile(join(`${path}.claims`, hash), "utf8"), `${hash}\n`);
  assert.equal((await readFile(path, "utf8")).includes(rawKey), false);
});

test("a staged claim is invisible before the canonical link", async () => {
  const path = await createLedgerPath();
  const rawKey = "thread:turn:item:before-link";
  const hash = sha256(rawKey);
  const injectedFailure = new Error("stop before claim link");
  let ledger;
  ledger = await openLedger(path, {
    beforeClaimLink: async ({ canonicalPath }) => {
      assert.equal(ledger.has(rawKey), false);
      await assert.rejects(readFile(canonicalPath), (error) => error?.code === "ENOENT");
      const observer = await openLedger(path);
      assert.equal(observer.has(rawKey), false);
      await observer.close();
      throw injectedFailure;
    },
  });

  await assert.rejects(ledger.mark(rawKey), (error) => error === injectedFailure);
  assert.equal(ledger.has(rawKey), false);
  await ledger.close();
  assert.deepEqual(await readdir(`${path}.claim-staging`), []);
  await assert.rejects(
    readFile(join(`${path}.claims`, hash)),
    (error) => error?.code === "ENOENT",
  );
});

test("orphan claim staging files are ignored", async () => {
  const path = await createLedgerPath();
  const rawKey = "thread:turn:item:orphan-stage";
  await mkdir(`${path}.claim-staging`, { recursive: true });
  await writeFile(join(`${path}.claim-staging`, "orphan.partial"), `${sha256(rawKey)}\n`);

  const ledger = await openLedger(path);
  assert.equal(ledger.has(rawKey), false);
  assert.deepEqual(await ledger.mark(rawKey), expectedResult(true));
  await ledger.close();
});

test("live empty or corrupt canonical claims fail closed", async () => {
  for (const contents of ["", `${sha256("wrong-content")}\n`]) {
    const path = await createLedgerPath();
    const rawKey = "thread:turn:item:corrupt-live-claim";
    const hash = sha256(rawKey);
    const ledger = await openLedger(path);
    await writeFile(join(`${path}.claims`, hash), contents);

    assert.throws(() => ledger.has(rawKey), hasExactError("LEDGER_CORRUPT"));
    await assert.rejects(ledger.mark(rawKey), hasExactError("LEDGER_CORRUPT"));
    await ledger.close();
  }
});

for (const [label, injectedOptions, expectedLedger] of [
  ["append", { appendLedger: async () => { throw new Error("append failed"); } }, ""],
  ["sync", { syncLedger: async () => { throw new Error("sync failed"); } }, "written"],
  ["close", {
    closeLedgerWrite: async (handle) => {
      await handle.close();
      throw new Error("close failed");
    },
  }, "written"],
]) {
  test(`a post-claim ledger ${label} failure returns marked true`, async () => {
    const path = await createLedgerPath();
    const rawKey = `thread:turn:item:${label}-failure`;
    const ledger = await openLedger(path, injectedOptions);

    const result = await ledger.mark(rawKey);
    assert.equal(result.marked, true);
    assert.equal(result.ledgerError?.message, `${label} failed`);
    assert.equal(result.cleanupError, null);
    assert.deepEqual(await ledger.mark(rawKey), expectedResult(false));
    assert.equal(ledger.has(rawKey), true);
    await ledger.close();
    if (expectedLedger === "") {
      assert.equal(await readFile(path, "utf8"), "");
    } else {
      assert.equal(await readFile(path, "utf8"), `${sha256(rawKey)}\n`);
    }

    const reopened = await openLedger(path);
    assert.equal(reopened.has(rawKey), true);
    assert.deepEqual(await reopened.mark(rawKey), expectedResult(false));
    await reopened.close();
  });
}

test("a partial derived append does not block recovery from the committed claim", async () => {
  const path = await createLedgerPath();
  const rawKey = "thread:turn:item:partial-derived-append";
  const appendFailure = new Error("partial append failed");
  const ledger = await openLedger(path, {
    appendLedger: async (handle, line) => {
      await handle.writeFile(line.slice(0, 10), "utf8");
      throw appendFailure;
    },
  });

  const result = await ledger.mark(rawKey);
  assert.equal(result.marked, true);
  assert.equal(result.ledgerError, appendFailure);
  await ledger.close();
  assert.equal((await readFile(path, "utf8")).length, 10);

  const reopened = await openLedger(path);
  assert.equal(reopened.has(rawKey), true);
  assert.deepEqual(await reopened.mark(rawKey), expectedResult(false));
  await reopened.close();
});

test("post-link staging cleanup failure is returned without rejecting", async () => {
  const path = await createLedgerPath();
  const rawKey = "thread:turn:item:cleanup-failure";
  const cleanupFailure = new Error("stage cleanup failed");
  const ledger = await openLedger(path, {
    removeStage: async () => {
      throw cleanupFailure;
    },
  });

  const result = await ledger.mark(rawKey);
  assert.equal(result.marked, true);
  assert.equal(result.ledgerError, null);
  assert.equal(result.cleanupError, cleanupFailure);
  await ledger.close();

  const reopened = await openLedger(path);
  assert.equal(reopened.has(rawKey), true);
  assert.deepEqual(await reopened.mark(rawKey), expectedResult(false));
  await reopened.close();
});

test("openLedger rejects corrupt ledger lines and unterminated hashes", async () => {
  for (const contents of [
    `${sha256("valid")}\nnot-a-hash\n`,
    sha256("unterminated"),
  ]) {
    const path = await createLedgerPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
    await assert.rejects(openLedger(path), hasExactError("LEDGER_CORRUPT"));
  }
});

test("valid readiness makes canonical claims authoritative over a torn text ledger", async () => {
  const path = await createLedgerPath();
  const rawKey = "thread:turn:item:ready-recovery";
  const hash = sha256(rawKey);
  await mkdir(`${path}.claims`, { recursive: true });
  await writeFile(path, "0123456789");
  await writeFile(`${path}.claims-ready`, READY_CONTENT);
  await writeFile(join(`${path}.claims`, hash), `${hash}\n`);

  const ledger = await openLedger(path);
  assert.equal(ledger.has(rawKey), true);
  assert.deepEqual(await ledger.mark(rawKey), expectedResult(false));
  await ledger.close();
});

test("ready startup does not create or open the derived ledger for append", async () => {
  const path = await createLedgerPath();
  const rawKey = "thread:turn:item:ready-without-derived-ledger";
  const hash = sha256(rawKey);
  let appendOpenAttempts = 0;
  await mkdir(`${path}.claims`, { recursive: true });
  await writeFile(`${path}.claims-ready`, READY_CONTENT);
  await writeFile(join(`${path}.claims`, hash), `${hash}\n`);

  const ledger = await openLedger(path, {
    openLedgerWrite: async () => {
      appendOpenAttempts += 1;
      throw Object.assign(new Error("derived ledger denied"), { code: "EPERM" });
    },
  });
  assert.equal(ledger.has(rawKey), true);
  assert.deepEqual(await ledger.mark(rawKey), expectedResult(false));
  assert.equal(appendOpenAttempts, 0);
  await ledger.close();
  await assert.rejects(readFile(path), (error) => error?.code === "ENOENT");
});

test("lazy derived-ledger open failure is typed after a new canonical claim", async () => {
  const path = await createLedgerPath();
  const rawKey = "thread:turn:item:lazy-derived-open-failure";
  const openFailure = Object.assign(new Error("derived ledger denied"), { code: "EPERM" });
  await mkdir(`${path}.claims`, { recursive: true });
  await writeFile(`${path}.claims-ready`, READY_CONTENT);
  const ledger = await openLedger(path, {
    openLedgerWrite: async () => {
      throw openFailure;
    },
  });

  const result = await ledger.mark(rawKey);
  assert.equal(result.marked, true);
  assert.equal(result.ledgerError, openFailure);
  assert.equal(ledger.has(rawKey), true);
  await ledger.close();

  const reopened = await openLedger(path);
  assert.equal(reopened.has(rawKey), true);
  assert.deepEqual(await reopened.mark(rawKey), expectedResult(false));
  await reopened.close();
});

test("an invalid readiness marker fails closed", async () => {
  const path = await createLedgerPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "");
  await writeFile(`${path}.claims-ready`, "wrong-version\n");

  await assert.rejects(openLedger(path), hasExactError("LEDGER_CORRUPT"));
});

test("openLedger validates canonical claim names and final contents", async () => {
  for (const [name, contents] of [
    ["not-a-hash", "not-a-hash\n"],
    [sha256("empty"), ""],
    [sha256("filename"), `${sha256("different-content")}\n`],
  ]) {
    const path = await createLedgerPath();
    await mkdir(`${path}.claims`, { recursive: true });
    await writeFile(join(`${path}.claims`, name), contents);
    await assert.rejects(openLedger(path), hasExactError("LEDGER_CORRUPT"));
  }
});

test("openLedger creates canonical claims for legacy ledger hashes", async () => {
  const path = await createLedgerPath();
  const hash = sha256("legacy-entry");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${hash}\n`);

  const ledger = await openLedger(path);
  await ledger.close();
  assert.equal(await readFile(join(`${path}.claims`, hash), "utf8"), `${hash}\n`);
});

test("invalid keys and operations after close report stable errors", async () => {
  const path = await createLedgerPath();
  const ledger = await openLedger(path);

  for (const invalidKey of ["", null, undefined, 42]) {
    assert.throws(() => ledger.has(invalidKey), hasExactError("LEDGER_KEY"));
    await assert.rejects(ledger.mark(invalidKey), hasExactError("LEDGER_KEY"));
  }

  await ledger.close();
  assert.throws(() => ledger.has("valid"), hasExactError("LEDGER_CLOSED"));
  await assert.rejects(ledger.mark("valid"), hasExactError("LEDGER_CLOSED"));
});
