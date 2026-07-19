import { randomUUID } from "node:crypto";
import { link, mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function serializeJson(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch {
    throw stableError("JSON_SERIALIZE");
  }

  if (serialized === undefined) {
    throw stableError("JSON_SERIALIZE");
  }
  return `${serialized}\n`;
}

export async function writeJsonOnce(path, value, { remove = rm } = {}) {
  const contents = serializeJson(value);
  await mkdir(dirname(path), { recursive: true });

  const partial = `${path}.${randomUUID()}.partial`;
  let handle;
  let ownsPartial = false;

  try {
    handle = await open(partial, "wx");
    ownsPartial = true;

    let writeError;
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } catch (error) {
      writeError = error;
    } finally {
      try {
        await handle.close();
      } catch (error) {
        writeError ??= error;
      }
      handle = undefined;
    }

    if (writeError) {
      throw writeError;
    }

    try {
      await link(partial, path);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw stableError("WRITE_ONCE_CONFLICT");
      }
      throw error;
    }
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the primary failure.
      }
    }
    if (ownsPartial) {
      try {
        await remove(partial, { force: true });
      } catch {
        // Before publication, cleanup must not mask the primary failure.
      }
    }
    throw error;
  }

  let cleanupError = null;
  try {
    await remove(partial, { force: true });
  } catch (error) {
    cleanupError = error;
  }

  return { path, published: true, cleanupError };
}
