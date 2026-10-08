import fs from "node:fs";
import path from "node:path";

const UTF8_FLAG = 0x0800;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function requireZip(condition, message) {
  if (!condition) throw new Error(`ZIP UTF-8 validation: ${message}`);
}

function utf8(bytes, field) {
  try { return decoder.decode(bytes); }
  catch { throw new Error(`ZIP UTF-8 validation: ${field} is not valid UTF-8; refusing to reinterpret a legacy encoding`); }
}

// PKWARE APPNOTE 6.3.10, 4.4.4 / Appendix D: bit 11 declares BOTH the
// filename and file comment UTF-8. Set it in matching local/central headers
// only after the raw names match the known staging tree, never by guessing
// the encoding of arbitrary ZIPs. Payloads, extra fields and modes stay intact.
// https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
export function markZipUtf8Names(bytes, expectedNames) {
  requireZip(Buffer.isBuffer(bytes), "archive must be a Buffer");
  requireZip(expectedNames instanceof Set, "known staged entry names are required");
  requireZip(bytes.length >= 22, "truncated end record");
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 65535); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {
      end = offset;
      break;
    }
  }
  requireZip(end >= 0, "end record not found");
  const disk = bytes.readUInt16LE(end + 4);
  const directoryDisk = bytes.readUInt16LE(end + 6);
  const diskEntries = bytes.readUInt16LE(end + 8);
  const entries = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  requireZip(entries !== 0xffff && diskEntries !== 0xffff && directorySize !== 0xffffffff && directoryOffset !== 0xffffffff,
    "ZIP64 is not supported by this release header repair");
  requireZip(disk === 0 && directoryDisk === 0 && diskEntries === entries, "split archives are unsupported");
  requireZip(directoryOffset + directorySize === end, "invalid central directory bounds");

  const seen = new Set();
  const localOffsets = new Set();
  const patches = [];
  const regions = [];
  let position = directoryOffset;
  for (let index = 0; index < entries; index++) {
    requireZip(position + 46 <= end && bytes.readUInt32LE(position) === 0x02014b50, "truncated or invalid central header");
    const flags = bytes.readUInt16LE(position + 8);
    const compressedSize = bytes.readUInt32LE(position + 20);
    const uncompressedSize = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28);
    const extraLength = bytes.readUInt16LE(position + 30);
    const commentLength = bytes.readUInt16LE(position + 32);
    const startDisk = bytes.readUInt16LE(position + 34);
    const local = bytes.readUInt32LE(position + 42);
    const next = position + 46 + nameLength + extraLength + commentLength;
    requireZip(nameLength > 0 && next <= end, "invalid central name/extra/comment bounds");
    requireZip(startDisk === 0, "split entry is unsupported");
    requireZip(compressedSize !== 0xffffffff && uncompressedSize !== 0xffffffff && local !== 0xffffffff,
      "ZIP64 entry is unsupported");
    requireZip((flags & 0x2041) === 0, "encrypted entries are unsupported");
    const rawName = bytes.subarray(position + 46, position + 46 + nameLength);
    const name = utf8(rawName, "filename");
    requireZip(expectedNames.has(name), `entry does not match staged UTF-8 filename: ${JSON.stringify(name)}`);
    requireZip(!seen.has(name), `duplicate entry: ${JSON.stringify(name)}`);
    seen.add(name);

    requireZip(local + 30 <= directoryOffset && bytes.readUInt32LE(local) === 0x04034b50, "invalid local header offset/signature");
    requireZip(!localOffsets.has(local), "central entries share a local header");
    localOffsets.add(local);
    const localFlags = bytes.readUInt16LE(local + 6);
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    const payload = local + 30 + localNameLength + localExtraLength;
    requireZip(payload + compressedSize <= directoryOffset, "invalid local name/extra/payload bounds");
    requireZip(localFlags === flags, "local and central flags disagree");
    requireZip(bytes.readUInt16LE(local + 8) === bytes.readUInt16LE(position + 10), "local and central compression disagree");
    requireZip(localNameLength === nameLength && bytes.subarray(local + 30, local + 30 + localNameLength).equals(rawName),
      "local and central filenames disagree");
    if (!(flags & 0x0008)) {
      requireZip(bytes.readUInt32LE(local + 14) === bytes.readUInt32LE(position + 16)
        && bytes.readUInt32LE(local + 18) === compressedSize && bytes.readUInt32LE(local + 22) === uncompressedSize,
      "local and central CRC/sizes disagree");
    }
    regions.push({ start: local, end: payload + compressedSize });

    const comment = bytes.subarray(next - commentLength, next);
    if (flags & UTF8_FLAG) utf8(comment, "UTF-8 file comment");
    else if (rawName.some((byte) => byte >= 0x80)) {
      // The staging tree establishes the filename encoding, not comment
      // provenance. ASCII comments are compatible with UTF-8 and CP437.
      requireZip(!comment.some((byte) => byte >= 0x80), "cannot relabel an unverified non-ASCII file comment");
      patches.push({ local: local + 6, central: position + 8, flags: flags | UTF8_FLAG });
    }
    position = next;
  }
  requireZip(position === end, "central directory size/count mismatch or unsupported extra record");
  requireZip(seen.size === expectedNames.size && [...expectedNames].every((name) => seen.has(name)), "staged entries are missing from archive");
  regions.sort((a, b) => a.start - b.start);
  for (let index = 1; index < regions.length; index++) {
    requireZip(regions[index].start >= regions[index - 1].end, "local entry regions overlap");
  }
  // Validate the whole archive before changing even one flag.
  for (const patch of patches) {
    bytes.writeUInt16LE(patch.flags, patch.local);
    bytes.writeUInt16LE(patch.flags, patch.central);
  }
  return { entries, changedEntries: patches.length };
}

export function normalizeZipUtf8Names(archive, stage) {
  const rootName = path.basename(stage);
  const expectedNames = new Set([`${rootName}/`]);
  for (const relative of fs.readdirSync(stage, { recursive: true })) {
    const suffix = fs.lstatSync(path.join(stage, relative)).isDirectory() ? "/" : "";
    expectedNames.add(`${rootName}/${relative.split(path.sep).join("/")}${suffix}`);
  }
  const bytes = fs.readFileSync(archive);
  const result = markZipUtf8Names(bytes, expectedNames);
  if (result.changedEntries) fs.writeFileSync(archive, bytes);
  return result;
}
