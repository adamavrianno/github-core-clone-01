// pkt-line codec (git's framing) and the side-band framing used by the
// smart-HTTP protocol.
//
// A pkt-line is a 4-hex-digit length (the length of the whole line, header
// included) followed by that many bytes minus four. The special lines are
// 0000 (flush), 0001 (delim) and 0002 (response-end). No data pkt-line may
// exceed 65520 bytes total. Side-band packets carry one leading band byte
// (1 = data, 2 = progress, 3 = error) inside a pkt-line, so their payload
// chunks are at most 65515 bytes.

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface PktPacket {
  readonly kind: PktKind;
  readonly payload: Buffer;
}

/** The 4-byte flush packet: 0000. */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The 4-byte delim packet: 0001. */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** The 4-byte response-end packet: 0002. */
export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

function encodeLength(length: number): string {
  return length.toString(16).padStart(4, '0');
}

/** Encode one data payload as a pkt-line. Throws when it would exceed 65520. */
export function pktLine(data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const total = body.length + 4;
  if (total > 65520) throw new Error(`pkt-line of ${total} bytes exceeds the 65520 limit`);
  return Buffer.concat([Buffer.from(encodeLength(total), 'ascii'), body]);
}

/**
 * Encode a mixed sequence: strings and Buffers become data pkt-lines,
 * 'flush' / 'delim' / 'response-end' become the control packets.
 */
export function encodePktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else if (item === 'response-end') parts.push(pktResponseEnd());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode a whole buffer of pkt-lines. Throws on a truncated line, a bad
 * length, or a length past the buffer's end. A flush/delim/response-end
 * packet carries an empty payload.
 */
export function decodePktLines(buf: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (header === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (header === '0002') {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length < 4) throw new Error(`pkt-line length ${length} is below 4`);
    if (offset + length > buf.length) throw new Error('truncated pkt-line body');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/**
 * Split a buffer at the first flush packet: returns the packets before it
 * and the byte offset just past it. Throws when no flush is present.
 */
export function splitAtFlush(buf: Buffer): { packets: PktPacket[]; rest: Buffer } {
  let offset = 0;
  const packets: PktPacket[] = [];
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      return { packets, rest: buf.subarray(offset + 4) };
    }
    // Decode one packet at a time from this offset.
    if (header === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (header === '0002') {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length < 4 || offset + length > buf.length) throw new Error('truncated pkt-line body');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  throw new Error('no flush packet in pkt-line stream');
}

/** The largest payload one side-band pkt-line may carry (65520 - 4 - 1). */
export const SIDEBAND_MAX_PAYLOAD = 65515;

/**
 * Wrap bytes as side-band packets of one band, chunked to the pkt-line
 * limit. An empty input produces no packets; callers that need at least one
 * packet (an empty packfile section) pass a non-empty buffer.
 */
export function sidebandPackets(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let offset = 0;
  while (offset < data.length) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + SIDEBAND_MAX_PAYLOAD));
    const framed = Buffer.concat([Buffer.from([band]), chunk]);
    out.push(pktLine(framed));
    offset += chunk.length;
  }
  return out;
}
