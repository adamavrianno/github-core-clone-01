// Git objects and packfiles, standard library only (node:crypto for SHA-1,
// node:zlib for deflate/inflate).
//
// Object ids are SHA-1 over `<type> <size>\0` + bytes. Packfiles are version
// 2: `PACK` + version + count, then one entry per object (a varint type+size
// header plus a zlib stream), then a 20-byte SHA-1 trailer over everything
// before it. The forge sends whole objects only (no deltas on the sending
// side); on the receiving side it resolves both delta forms (OFS_DELTA and
// REF_DELTA) by applying their copy/insert instructions onto the base object.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

/** The all-zero object id: an absent ref, a create's old id, a delete's new id. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

const OID_RE = /^[0-9a-f]{40}$/;

/** True when the string is a 40-hex object id. */
export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

/** SHA-1 of `<type> <size>\0` + data, as 40 hex characters. */
export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** A git object: its type and raw bytes (without the `<type> <size>\0` header). */
export interface GitObject {
  readonly type: 'commit' | 'tree' | 'blob' | 'tag';
  readonly data: Buffer;
}

export type ObjectType = GitObject['type'];

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Build a tree object from entries sorted git-style (dirs compare as name + '/'). */
export function buildTree(entries: ReadonlyArray<{ mode: string; name: string; oid: string }>): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const aKey = a.mode === '40000' ? `${a.name}/` : a.name;
    const bKey = b.mode === '40000' ? `${b.name}/` : b.name;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: no space after mode');
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree: no NUL after name');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** One identity line: `Name <email> <unix seconds> +0000`. */
export function identityLine(name: string, email: string, timestampSec: number): string {
  return `${name} <${email}> ${timestampSec} +0000`;
}

/** Build a commit object. Parents are listed in order. */
export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  /** The author line's unix timestamp, or null when it does not parse. */
  readonly timestamp: number | null;
}

function parseIdentityTimestamp(line: string): number | null {
  const match = / (\d+) [+-]\d{4}$/.exec(line);
  return match === null ? null : Number(match[1]);
}

/** Parse a commit object. Throws on a malformed header. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (tree === '' || !isOid(tree)) throw new Error('malformed commit: no tree');
  return { tree, parents, author, committer, message, timestamp: parseIdentityTimestamp(author) };
}

/** Build an annotated tag object. */
export function buildTag(input: {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}): Buffer {
  return Buffer.from(
    `object ${input.object}\ntype ${input.type}\ntag ${input.tag}\ntagger ${input.tagger}\n\n${input.message}`,
    'utf8',
  );
}

export interface ParsedTag {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. Throws on a malformed header. */
export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  if (object === '' || !isOid(object)) throw new Error('malformed tag: no object');
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- packfiles

/** Encode a pack object header: the type and size as a little-endian varint. */
function encodeObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining >>>= 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/**
 * Write a version 2 packfile of whole objects (no deltas). Objects are
 * written in the order given; the trailer is SHA-1 over everything before it.
 */
export function writePack(objects: ReadonlyArray<GitObject>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(encodeObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const beforeTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(beforeTrailer).digest();
  return Buffer.concat([beforeTrailer, trailer]);
}

/** Verify a packfile's trailer. Returns the expected and actual digests. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 32) return { ok: false, expected: '', actual: '' };
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: expected === actual, expected, actual };
}

interface PackEntryHeader {
  readonly type: ObjectType | 'ofs-delta' | 'ref-delta';
  readonly size: number;
  /** Bytes consumed by the header (and, for deltas, the base locator). */
  readonly headerLength: number;
  /** OFS_DELTA: the base object's offset back from this entry's start. */
  readonly baseOffset?: number;
  /** REF_DELTA: the base object's id. */
  readonly baseOid?: string;
}

/** Read one pack entry header at an offset. Throws on a bad type or truncation. */
function readEntryHeader(pack: Buffer, offset: number): PackEntryHeader {
  if (offset >= pack.length) throw new Error('pack entry past the end');
  const first = pack[offset] as number;
  const code = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;
  let pos = offset + 1;
  let byte = first;
  while ((byte & 0x80) !== 0) {
    if (pos >= pack.length) throw new Error('truncated pack entry header');
    byte = pack[pos] as number;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  if (code >= 1 && code <= 4) {
    return { type: CODE_TYPES[code] as ObjectType, size, headerLength: pos - offset };
  }
  if (code === 6) {
    // OFS_DELTA: an offset varint where each byte but the last adds one.
    if (pos >= pack.length) throw new Error('truncated OFS_DELTA base offset');
    let baseByte = pack[pos] as number;
    let baseOffset = baseByte & 0x7f;
    pos += 1;
    while ((baseByte & 0x80) !== 0) {
      if (pos >= pack.length) throw new Error('truncated OFS_DELTA base offset');
      baseByte = pack[pos] as number;
      baseOffset = ((baseOffset + 1) << 7) | (baseByte & 0x7f);
      pos += 1;
    }
    return { type: 'ofs-delta', size, headerLength: pos - offset, baseOffset };
  }
  if (code === 7) {
    if (pos + 20 > pack.length) throw new Error('truncated REF_DELTA base id');
    const baseOid = pack.subarray(pos, pos + 20).toString('hex');
    return { type: 'ref-delta', size, headerLength: pos - offset + 20, baseOid };
  }
  throw new Error(`unknown pack entry type ${code}`);
}

/** Read a varint from a delta stream. Returns the value and bytes consumed. */
function readDeltaVarint(data: Buffer, offset: number): { value: number; length: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= data.length) throw new Error('truncated delta varint');
    const byte = data[pos] as number;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    pos += 1;
    if ((byte & 0x80) === 0) break;
  }
  return { value, length: pos - offset };
}

/**
 * Apply a delta to its base object. The delta is: base size varint, result
 * size varint, then instructions — copy (high bit set: offset/size bytes
 * follow) or insert (low 7 bits are the literal length, 0 means a copy of
 * nothing and is invalid). Throws when the sizes or instructions do not fit.
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const baseSize = readDeltaVarint(delta, 0);
  if (baseSize.value !== base.length) throw new Error(`delta base size ${baseSize.value} does not match ${base.length}`);
  const resultSize = readDeltaVarint(delta, baseSize.length);
  const chunks: Buffer[] = [];
  let produced = 0;
  let pos = baseSize.length + resultSize.length;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) {
        if (pos >= delta.length) throw new Error('truncated delta copy offset');
        offset = delta[pos] as number;
        pos += 1;
      }
      if ((op & 0x02) !== 0) {
        if (pos >= delta.length) throw new Error('truncated delta copy offset');
        offset |= (delta[pos] as number) << 8;
        pos += 1;
      }
      if ((op & 0x04) !== 0) {
        if (pos >= delta.length) throw new Error('truncated delta copy offset');
        offset |= (delta[pos] as number) << 16;
        pos += 1;
      }
      if ((op & 0x08) !== 0) {
        if (pos >= delta.length) throw new Error('truncated delta copy offset');
        offset |= (delta[pos] as number) << 24;
        pos += 1;
      }
      if ((op & 0x10) !== 0) {
        if (pos >= delta.length) throw new Error('truncated delta copy size');
        size = delta[pos] as number;
        pos += 1;
      }
      if ((op & 0x20) !== 0) {
        if (pos >= delta.length) throw new Error('truncated delta copy size');
        size |= (delta[pos] as number) << 8;
        pos += 1;
      }
      if ((op & 0x40) !== 0) {
        if (pos >= delta.length) throw new Error('truncated delta copy size');
        size |= (delta[pos] as number) << 16;
        pos += 1;
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past the base object');
      chunks.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new Error('truncated delta insert');
      chunks.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta instruction 0x00 is reserved');
    }
  }
  if (produced !== resultSize.value) {
    throw new Error(`delta produced ${produced} bytes, expected ${resultSize.value}`);
  }
  return Buffer.concat(chunks);
}

export interface ReadPackResult {
  /** Every object in the pack, keyed by id, in pack order. */
  readonly objects: Map<string, GitObject>;
  /** How many delta entries the pack carried. */
  readonly deltaCount: number;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object. OFS_DELTA bases
 * must be earlier entries in the same pack; REF_DELTA bases may be in the
 * pack or supplied by `resolveBase` (the receiver's own store, for thin
 * packs). The trailer checksum is verified first. Throws on any malformed
 * entry, unresolved base, or size mismatch.
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): ReadPackResult {
  if (pack.length < 32) throw new Error('pack too short for a header and trailer');
  const checksum = verifyPackChecksum(pack);
  if (!checksum.ok) throw new Error(`pack trailer ${checksum.actual} does not match its bytes ${checksum.expected}`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const bodyEnd = pack.length - 20;
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let offset = 12;
  // Deltas may reference bases later in the pack only for REF_DELTA by id;
  // resolve those in a second pass after every whole object is read.
  const pending: Array<{ entryOffset: number; header: PackEntryHeader; delta: Buffer }> = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readEntryHeader(pack, offset);
    offset += header.headerLength;
    if (offset >= bodyEnd) throw new Error('pack entry has no zlib stream');
    let inflated: Buffer;
    try {
      // inflateSync ignores bytes past the stream's end, so this yields the
      // entry's data even though later entries follow it in the buffer.
      inflated = inflateSync(pack.subarray(offset, bodyEnd));
    } catch {
      throw new Error('pack entry zlib stream is corrupt');
    }
    // Find the stream's end by binary search: a prefix shorter than the
    // stream throws ("unexpected end of file"), a prefix at or past its end
    // inflates to the same bytes. The smallest succeeding prefix is the end.
    offset = skipZlibStream(pack, offset, bodyEnd, header.size);
    if (header.type === 'ofs-delta' || header.type === 'ref-delta') {
      deltaCount += 1;
      pending.push({ entryOffset, header, delta: inflated });
      continue;
    }
    if (inflated.length !== header.size) {
      throw new Error(`pack object size ${inflated.length} does not match its header ${header.size}`);
    }
    const object: GitObject = { type: header.type, data: inflated };
    const oid = hashObject(object.type, object.data);
    objects.set(oid, object);
    byOffset.set(entryOffset, object);
  }
  for (const item of pending) {
    let base: GitObject | undefined;
    if (item.header.type === 'ofs-delta') {
      const baseOffset = item.entryOffset - (item.header.baseOffset ?? 0);
      base = byOffset.get(baseOffset);
      if (base === undefined) throw new Error('OFS_DELTA base is not in the pack');
    } else {
      const baseOid = item.header.baseOid as string;
      base = objects.get(baseOid) ?? resolveBase?.(baseOid);
      if (base === undefined) throw new Error(`REF_DELTA base ${baseOid} is neither in the pack nor on the server`);
    }
    // applyDelta already verifies the result against the delta header's own
    // target size; the pack entry header's size is the delta stream's
    // length, not the result's, so it must not be compared here.
    const data = applyDelta(base.data, item.delta);
    const object: GitObject = { type: base.type, data };
    const oid = hashObject(object.type, object.data);
    objects.set(oid, object);
    byOffset.set(item.entryOffset, object);
  }
  return { objects, deltaCount };
}

/**
 * Find where a zlib stream starting at `start` ends. A prefix shorter than
 * the stream throws on inflate; a prefix at or past its end inflates to the
 * expected size. Binary search finds the smallest succeeding prefix in
 * O(log n) inflations.
 */
function skipZlibStream(pack: Buffer, start: number, end: number, expectedSize: number): number {
  const succeeds = (cut: number): boolean => {
    try {
      return inflateSync(pack.subarray(start, cut)).length === expectedSize;
    } catch {
      return false;
    }
  };
  if (!succeeds(end)) throw new Error('could not find the end of a pack entry zlib stream');
  let lo = start + 1;
  let hi = end;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (succeeds(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
