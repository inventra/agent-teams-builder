import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { markZipUtf8Names, normalizeZipUtf8Names } from "../scripts/zip-utf8.mjs";

// Small real ZIP fixtures, including streamed data descriptors and Unix modes.
// The payload CRC is the standard CRC32 vector for "hello" (or an empty file).
function fixture(entries, archiveComment = Buffer.alloc(0)) {
  const locals = [], centrals = [], records = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = entry.rawName || Buffer.from(entry.name, "utf8");
    const flags = entry.flags || 0;
    const comment = entry.comment || Buffer.alloc(0);
    const extra = Buffer.from([0x55, 0x54, 0x01, 0x00, 0x00]);
    const empty = entry.name.endsWith("/");
    const data = Buffer.from(empty ? "" : "hello");
    const compressed = empty ? data : deflateRawSync(data);
    const crc = empty ? 0 : 0x3610a686;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(empty ? 0 : 8, 8);
    if (!(flags & 8)) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(data.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const descriptor = Buffer.alloc(flags & 8 ? 16 : 0);
    if (descriptor.length) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(data.length, 12);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(empty ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt16LE(comment.length, 32);
    central.writeUInt32LE(((entry.mode || (empty ? 0o40755 : 0o100755)) << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    const localRecord = Buffer.concat([local, name, extra, compressed, descriptor]);
    locals.push(localRecord);
    centrals.push(Buffer.concat([central, name, extra, comment]));
    records.push({ local: localOffset, central: 0, compressed, descriptor });
    localOffset += localRecord.length;
  }
  const directory = Buffer.concat(centrals);
  let centralOffset = localOffset;
  records.forEach((record, index) => { record.central = centralOffset; centralOffset += centrals[index].length; });
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(archiveComment.length, 20);
  return { bytes: Buffer.concat([...locals, directory, end, archiveComment]), records,
    expected: new Set(entries.map((entry) => entry.name)), end: centralOffset };
}

function refusesWithoutChanges(archive, pattern) {
  const before = Buffer.from(archive.bytes);
  assert.throws(() => markZipUtf8Names(archive.bytes, archive.expected), pattern);
  assert.deepEqual(archive.bytes, before);
}

test("marks matching UTF-8 names in both headers and preserves every other byte", () => {
  const archive = fixture([
    { name: "release/README-安裝說明.md", flags: 8, comment: Buffer.from("ASCII comment") },
    { name: "release/docs/功能對照表.md", flags: 8 },
    { name: "release/Install-Agent-Builder.exe", mode: 0o100755 },
    { name: "release/Install Agent Teams Builder.app/", mode: 0o40755 }
  ], Buffer.from("EOCD-like comment PK\u0005\u0006"));
  const expected = Buffer.from(archive.bytes);
  for (const record of archive.records.slice(0, 2)) {
    expected.writeUInt16LE(0x808, record.local + 6);
    expected.writeUInt16LE(0x808, record.central + 8);
  }
  assert.deepEqual(markZipUtf8Names(archive.bytes, archive.expected), { entries: 4, changedEntries: 2 });
  assert.deepEqual(archive.bytes, expected); // Includes payloads, CRCs, descriptors, modes and extra fields.
  assert.deepEqual(markZipUtf8Names(archive.bytes, archive.expected), { entries: 4, changedEntries: 0 });
  assert.deepEqual(archive.bytes, expected);
});

test("ASCII names and correctly flagged UTF-8 names need no rewrite", () => {
  const archive = fixture([
    { name: "release/plain.txt" },
    { name: "release/說明.txt", flags: 0x808, comment: Buffer.from("UTF-8 評語") }
  ]);
  const before = Buffer.from(archive.bytes);
  assert.deepEqual(markZipUtf8Names(archive.bytes, archive.expected), { entries: 2, changedEntries: 0 });
  assert.deepEqual(archive.bytes, before);
});

test("rejects legacy or ambiguous filename bytes instead of guessing CP437", () => {
  for (const rawName of [Buffer.from([0x82, 0x2e, 0x74, 0x78, 0x74]), Buffer.from([0xc0, 0xaf])]) {
    refusesWithoutChanges(fixture([{ name: "é.txt", rawName }]), /not valid UTF-8/);
  }
  // C3 A9 is valid UTF-8 for é, but also two distinct CP437 characters.
  // Valid UTF-8 alone is insufficient: the known stage name must agree.
  refusesWithoutChanges(fixture([{ name: "├⌐.txt", rawName: Buffer.from("é.txt") }]), /does not match staged/);
  refusesWithoutChanges(fixture([{ name: "release/說明.txt", flags: 0x800, rawName: Buffer.from([0xff]) }]), /not valid UTF-8/);
});

test("refuses incompatible file comments and leaves earlier candidate headers untouched", () => {
  const archive = fixture([
    { name: "release/有效.txt", flags: 8 },
    { name: "release/另一份.txt", flags: 8, comment: Buffer.from([0x82]) }
  ]);
  refusesWithoutChanges(archive, /unverified non-ASCII file comment/);
  refusesWithoutChanges(fixture([{ name: "release/另一份.txt", flags: 0x800, comment: Buffer.from([0xff]) }]), /comment is not valid UTF-8/);
});

test("rejects malformed, duplicate, missing, split and ZIP64 records before patching", () => {
  const mutations = [
    [(a) => a.bytes.writeUInt32LE(0, a.records[0].central), /central header/],
    [(a) => a.bytes.writeUInt32LE(0, a.records[0].local), /local header/],
    [(a) => a.bytes.writeUInt16LE(0, a.records[0].local + 6), /flags disagree/],
    [(a) => a.bytes.writeUInt8(0x41, a.records[0].local + 30), /filenames disagree/],
    [(a) => a.bytes.writeUInt32LE(0xffffffff, a.records[0].central + 42), /ZIP64 entry/],
    [(a) => a.bytes.writeUInt32LE(a.end + 1, a.records[0].central + 42), /local header/],
    [(a) => a.bytes.writeUInt16LE(0xffff, a.end + 10), /ZIP64/],
    [(a) => a.bytes.writeUInt16LE(1, a.end + 4), /split archives/],
    [(a) => a.bytes.writeUInt16LE(1, a.records[0].central + 34), /split entry/],
    [(a) => a.bytes.writeUInt32LE(1, a.end + 12), /central directory bounds/],
    [(a) => a.bytes.writeUInt32LE(0x7fffffff, a.records[0].central + 20), /payload bounds/],
    [(a) => a.expected.add("release/missing.txt"), /staged entries are missing/],
    [(a) => a.bytes = a.bytes.subarray(0, a.bytes.length - 1), /end record not found/]
  ];
  for (const [mutate, pattern] of mutations) {
    const archive = fixture([{ name: "release/說明.txt", flags: 8 }]);
    mutate(archive);
    refusesWithoutChanges(archive, pattern);
  }
  refusesWithoutChanges(fixture([{ name: "release/說明.txt" }, { name: "release/說明.txt" }]), /duplicate entry/);
  assert.throws(() => markZipUtf8Names(Buffer.alloc(0), new Set()), /truncated/);
  assert.throws(() => markZipUtf8Names(Buffer.alloc(22)), /known staged entry names/);
});

test("archive/staging integration rewrites only encoding flags and is idempotent", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "zip-utf8-test-"));
  try {
    const stage = path.join(temporary, "Release with spaces");
    fs.mkdirSync(path.join(stage, "docs"), { recursive: true });
    fs.writeFileSync(path.join(stage, "docs", "說明.md"), "hello");
    const archive = fixture([{ name: "Release with spaces/" }, { name: "Release with spaces/docs/" },
      { name: "Release with spaces/docs/說明.md", flags: 8 }]);
    const file = path.join(temporary, "release.zip");
    fs.writeFileSync(file, archive.bytes);
    const result = normalizeZipUtf8Names(file, stage);
    assert.deepEqual(result, { entries: 3, changedEntries: 1 });
    const fixed = fs.readFileSync(file);
    assert.equal(fixed.length, archive.bytes.length);
    assert.deepEqual(normalizeZipUtf8Names(file, stage), { entries: 3, changedEntries: 0 });
    assert.deepEqual(fs.readFileSync(file), fixed);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

const python = ["python3", "python"].find((command) => {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", shell: false });
  return result.status === 0 && /^Python 3\./.test(`${result.stdout || ""}${result.stderr || ""}`.trim());
});
test("standard Python ZIP reader decodes names, extracts payload and retains executable modes", { skip: !python }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "zip-utf8-reader-"));
  try {
    const archive = fixture([{ name: "release/docs/功能對照表.md", flags: 8 },
      { name: "release/Install-Agent-Builder.exe", mode: 0o100755 }]);
    markZipUtf8Names(archive.bytes, archive.expected);
    const file = path.join(temporary, "release.zip");
    fs.writeFileSync(file, archive.bytes);
    const result = spawnSync(python, ["-X", "utf8", "-c", "import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n print(json.dumps([{'name':i.filename,'data':z.read(i).hex(),'mode':i.external_attr>>16,'flags':i.flag_bits} for i in z.infolist()]))", file], { encoding: "utf8", shell: false });
    assert.equal(result.status, 0, result.stderr);
    const decoded = JSON.parse(result.stdout);
    assert.deepEqual(decoded.map((entry) => entry.name), [...archive.expected]);
    assert.ok(decoded.every((entry) => entry.data === Buffer.from("hello").toString("hex") && entry.mode === 0o100755));
    assert.equal(decoded[0].flags, 0x808);
    assert.equal(decoded[1].flags, 0);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
