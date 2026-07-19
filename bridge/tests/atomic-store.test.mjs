import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import { writeJsonOnce } from "../src/atomic-store.mjs";

const temporaryDirectories = [];

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "hermes-atomic-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function assertNoPartials(target) {
  const entries = await readdir(dirname(target));
  const targetName = basename(target);
  assert.deepEqual(
    entries.filter((entry) => entry.startsWith(`${targetName}.`) && entry.endsWith(".partial")),
    [],
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("writeJsonOnce creates parent directories and writes formatted JSON with a trailing newline", async () => {
  const directory = await createTemporaryDirectory();
  const target = join(directory, "queue", "nested", "item.json");
  const value = { thread: "thread-1", sequence: 7 };

  const result = await writeJsonOnce(target, value);

  assert.deepEqual(result, { path: target, published: true, cleanupError: null });
  const contents = await readFile(target, "utf8");
  assert.equal(contents, `${JSON.stringify(value, null, 2)}\n`);
  assert.deepEqual(JSON.parse(contents), value);
  await assertNoPartials(target);
});

test("writeJsonOnce reports a stable conflict and preserves the original bytes", async () => {
  const directory = await createTemporaryDirectory();
  const target = join(directory, "queue", "item.json");

  await writeJsonOnce(target, { original: true });
  const original = await readFile(target);

  await assert.rejects(
    writeJsonOnce(target, { replacement: true }),
    (error) => error?.message === "WRITE_ONCE_CONFLICT" && error?.code === "WRITE_ONCE_CONFLICT",
  );

  assert.deepEqual(await readFile(target), original);
  await assertNoPartials(target);
});

test("writeJsonOnce removes only its own partial file", async () => {
  const directory = await createTemporaryDirectory();
  const target = join(directory, "queue", "item.json");
  const foreignPartial = `${target}.foreign.partial`;
  await mkdir(join(directory, "queue"), { recursive: true });
  await writeFile(foreignPartial, "owned elsewhere");

  await writeJsonOnce(target, { ok: true });

  assert.equal(await readFile(foreignPartial, "utf8"), "owned elsewhere");
  const entries = await readdir(join(directory, "queue"));
  assert.deepEqual(entries.sort(), ["item.json", "item.json.foreign.partial"]);
});

test("writeJsonOnce rejects non-JSON values before creating a target or partial", async () => {
  const directory = await createTemporaryDirectory();
  const circular = {};
  circular.self = circular;
  const invalidValues = [
    undefined,
    () => {},
    Symbol("invalid"),
    1n,
    circular,
    { toJSON: () => undefined },
  ];

  for (const [index, value] of invalidValues.entries()) {
    const target = join(directory, `invalid-${index}.json`);
    await assert.rejects(
      writeJsonOnce(target, value),
      (error) => error?.message === "JSON_SERIALIZE" && error?.code === "JSON_SERIALIZE",
    );
    assert.equal(
      (await readdir(directory)).some((entry) => entry.startsWith(`invalid-${index}.json`)),
      false,
    );
  }
});

test("writeJsonOnce resolves as published when post-link cleanup fails", async () => {
  const directory = await createTemporaryDirectory();
  const target = join(directory, "queue", "item.json");
  const cleanupFailure = new Error("injected cleanup failure");

  const result = await writeJsonOnce(
    target,
    { durable: true },
    {
      remove: async () => {
        throw cleanupFailure;
      },
    },
  );

  assert.equal(result.path, target);
  assert.equal(result.published, true);
  assert.equal(result.cleanupError, cleanupFailure);
  assert.equal(await readFile(target, "utf8"), `${JSON.stringify({ durable: true }, null, 2)}\n`);
  await assert.rejects(
    writeJsonOnce(target, { replacement: true }),
    (error) => error?.message === "WRITE_ONCE_CONFLICT" && error?.code === "WRITE_ONCE_CONFLICT",
  );
});
