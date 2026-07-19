import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const READY_CONTENT = "hermes-ledger-claims-v1\n";

function ledgerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function hashKey(rawKey) {
  if (typeof rawKey !== "string" || rawKey.length === 0) {
    throw ledgerError("LEDGER_KEY");
  }
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

function parseLedger(contents) {
  if (contents.length > 0 && !contents.endsWith("\n")) {
    throw ledgerError("LEDGER_CORRUPT");
  }

  const hashes = new Set();
  for (const line of contents.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    if (!HASH_PATTERN.test(line)) {
      throw ledgerError("LEDGER_CORRUPT");
    }
    hashes.add(line);
  }
  return hashes;
}

async function validateCanonicalClaim(path, hash) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    throw ledgerError("LEDGER_CORRUPT");
  }
  if (contents !== `${hash}\n`) {
    throw ledgerError("LEDGER_CORRUPT");
  }
}

function canonicalClaimExists(path, hash) {
  let contents;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw ledgerError("LEDGER_CORRUPT");
  }
  if (contents !== `${hash}\n`) {
    throw ledgerError("LEDGER_CORRUPT");
  }
  return true;
}

async function readinessExists(path) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw ledgerError("LEDGER_CORRUPT");
  }
  if (contents !== READY_CONTENT) {
    throw ledgerError("LEDGER_CORRUPT");
  }
  return true;
}

async function closeHandle(handle, primaryError) {
  try {
    await handle.close();
    return primaryError;
  } catch (error) {
    return primaryError ?? error;
  }
}

async function createCanonicalClaim({
  hash,
  claimsDirectory,
  stagingDirectory,
  beforeClaimLink,
  removeStage,
}) {
  const stagedPath = join(stagingDirectory, `${randomUUID()}.partial`);
  const canonicalPath = join(claimsDirectory, hash);
  let handle;
  let ownsStage = false;
  let primaryError;

  try {
    handle = await open(stagedPath, "wx");
    ownsStage = true;
    try {
      await handle.writeFile(`${hash}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      primaryError = error;
    }
    try {
      await handle.close();
      handle = undefined;
    } catch (error) {
      primaryError ??= error;
    }
    if (primaryError) {
      throw primaryError;
    }

    await beforeClaimLink({ stagedPath, canonicalPath, hash });

    let marked = true;
    try {
      await link(stagedPath, canonicalPath);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      await validateCanonicalClaim(canonicalPath, hash);
      marked = false;
    }

    let cleanupError = null;
    try {
      await removeStage(stagedPath, { force: true });
    } catch (error) {
      cleanupError = error;
    }
    return { marked, cleanupError };
  } catch (error) {
    if (handle) {
      await closeHandle(handle);
    }
    if (ownsStage) {
      try {
        await removeStage(stagedPath, { force: true });
      } catch {
        // Cleanup before the commit point must not mask the primary error.
      }
    }
    throw error;
  }
}

async function publishReadinessMarker(path, stagingDirectory) {
  const stagedPath = join(stagingDirectory, `${randomUUID()}.ready.partial`);
  let handle;
  let ownsStage = false;

  try {
    handle = await open(stagedPath, "wx");
    ownsStage = true;
    let primaryError;
    try {
      await handle.writeFile(READY_CONTENT, "utf8");
      await handle.sync();
    } catch (error) {
      primaryError = error;
    }
    try {
      await handle.close();
      handle = undefined;
    } catch (error) {
      primaryError ??= error;
    }
    if (primaryError) {
      throw primaryError;
    }

    try {
      await link(stagedPath, path);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (!await readinessExists(path)) {
        throw ledgerError("LEDGER_CORRUPT");
      }
    }

    try {
      await rm(stagedPath, { force: true });
    } catch {
      // The readiness marker is already committed; staging is non-authoritative.
    }
  } catch (error) {
    if (handle) {
      await closeHandle(handle);
    }
    if (ownsStage) {
      try {
        await rm(stagedPath, { force: true });
      } catch {
        // Preserve the failure that prevented or invalidated publication.
      }
    }
    throw error;
  }
}

async function validateClaimsDirectory(claimsDirectory) {
  const entries = await readdir(claimsDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !HASH_PATTERN.test(entry.name)) {
      throw ledgerError("LEDGER_CORRUPT");
    }
    await validateCanonicalClaim(join(claimsDirectory, entry.name), entry.name);
  }
}

async function readLegacyLedger(path) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      contents = "";
    } else {
      throw error;
    }
  }
  return parseLedger(contents);
}

export async function openLedger(path, {
  beforeClaimLink = async () => {},
  appendLedger = (handle, line) => handle.appendFile(line, "utf8"),
  syncLedger = (handle) => handle.sync(),
  closeLedgerWrite = (handle) => handle.close(),
  openLedgerWrite = (ledgerPath) => open(ledgerPath, "a"),
  removeStage = rm,
} = {}) {
  await mkdir(dirname(path), { recursive: true });
  const claimsDirectory = `${path}.claims`;
  const stagingDirectory = `${path}.claim-staging`;
  const readinessPath = `${path}.claims-ready`;
  await Promise.all([
    mkdir(claimsDirectory, { recursive: true }),
    mkdir(stagingDirectory, { recursive: true }),
  ]);
  let ready = await readinessExists(readinessPath);
  if (ready) {
    await validateClaimsDirectory(claimsDirectory);
  } else {
    let ledgerHashes;
    try {
      ledgerHashes = await readLegacyLedger(path);
    } catch (error) {
      ready = await readinessExists(readinessPath);
      if (!ready) {
        throw error;
      }
    }

    if (ready) {
      await validateClaimsDirectory(claimsDirectory);
    } else {
      await validateClaimsDirectory(claimsDirectory);
      for (const hash of ledgerHashes) {
        if (canonicalClaimExists(join(claimsDirectory, hash), hash)) {
          continue;
        }
        await createCanonicalClaim({
          hash,
          claimsDirectory,
          stagingDirectory,
          beforeClaimLink,
          removeStage,
        });
      }
      await validateClaimsDirectory(claimsDirectory);
      await publishReadinessMarker(readinessPath, stagingDirectory);
    }
  }

  let closed = false;
  let closePromise;
  let pending = Promise.resolve();

  function assertOpen() {
    if (closed) {
      throw ledgerError("LEDGER_CLOSED");
    }
  }

  return {
    has(rawKey) {
      assertOpen();
      const hash = hashKey(rawKey);
      return canonicalClaimExists(join(claimsDirectory, hash), hash);
    },

    mark(rawKey) {
      let hash;
      try {
        assertOpen();
        hash = hashKey(rawKey);
      } catch (error) {
        return Promise.reject(error);
      }

      const operation = pending.then(async () => {
        const canonicalPath = join(claimsDirectory, hash);
        if (canonicalClaimExists(canonicalPath, hash)) {
          return { marked: false, ledgerError: null, cleanupError: null };
        }

        const claimResult = await createCanonicalClaim({
          hash,
          claimsDirectory,
          stagingDirectory,
          beforeClaimLink,
          removeStage,
        });
        if (!claimResult.marked) {
          return { marked: false, ledgerError: null, cleanupError: claimResult.cleanupError };
        }

        let secondaryError = null;
        let writeHandle;
        try {
          writeHandle = await openLedgerWrite(path);
          await appendLedger(writeHandle, `${hash}\n`);
          await syncLedger(writeHandle);
        } catch (error) {
          secondaryError = error;
        } finally {
          if (writeHandle) {
            try {
              await closeLedgerWrite(writeHandle);
            } catch (error) {
              secondaryError ??= error;
            }
          }
        }
        return {
          marked: true,
          ledgerError: secondaryError,
          cleanupError: claimResult.cleanupError,
        };
      });

      pending = operation.catch(() => {});
      return operation;
    },

    close() {
      if (!closePromise) {
        closed = true;
        closePromise = pending.then(() => undefined);
      }
      return closePromise;
    },
  };
}
