// Git smart HTTP: clone, fetch and push over the info/refs, upload-pack
// and receive-pack endpoints.
//
// upload-pack speaks protocol v2 (capability advertisement, ls-refs, fetch
// with wants/haves/shallow/deepen) and v0 (ref advertisement, want/have
// negotiation) — the client chooses by the Git-Protocol request header.
// receive-pack is v0 only, with report-status, side-band-64k and
// delete-refs, and fast-forward-only enforcement per ref.
//
// A repository is created through REST only; a push cannot invent one, and
// a missing repository answers 404 on reference discovery while the server
// stays up. A malformed pkt-line body answers 400 and never kills the server.

import {
  ZERO_OID,
  isOid,
  readPack,
  writePack,
  type GitObject,
} from './gitobjects.ts';
import {
  decodePktLines,
  encodePktLines,
  pktLine,
  sidebandPackets,
  splitAtFlush,
  type PktPacket,
} from './pktline.ts';
import { peelToCommit, sortedRefs } from './store.ts';
import type { ForgeStore, Repo } from './store.ts';

export type GitService = 'git-upload-pack' | 'git-receive-pack';

import type { Reply } from './respond.ts';

type GitResponder = Reply;

const AGENT = 'forge/1.0';

/** What the router hands the git handlers: the parsed owner/repo/service. */
export interface GitRequest {
  readonly owner: string;
  readonly repoName: string;
  readonly service: GitService;
  /** True when the client asked for protocol v2 (Git-Protocol header). */
  readonly wantsV2: boolean;
  readonly query: URLSearchParams;
  readonly body: Buffer;
}

function notFound(res: GitResponder, message: string): void {
  res.json(404, { message });
}

function badRequest(res: GitResponder, message: string): void {
  res.json(400, { message });
}

/** The v2 capability lines the upload-pack advertisement carries. */
function v2Capabilities(): string[] {
  return [
    'version 2',
    'fetch=shallow',
    'ls-refs',
    'object-format=sha1',
    `agent=${AGENT}`,
  ];
}

/** The v0 capability string for upload-pack (after the NUL on line one). */
function v0UploadCapabilities(): string {
  return `side-band-64k thin-pack ofs-delta shallow multi_ack_detailed agent=${AGENT} symref=HEAD:refs/heads/main`;
}

/** The v0 capability string for receive-pack (after the NUL on line one). */
function v0ReceiveCapabilities(): string {
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;
}

/**
 * The v0 ref advertisement: HEAD first (with the capabilities after a NUL),
 * then branches and tags, peeled tags as `^{}` lines. An empty repository
 * advertises the zero id under the `capabilities^{}` pseudo-ref.
 */
function v0Advertisement(repo: Repo, capabilities: string): Buffer {
  const refs = sortedRefs(repo);
  const lines: Array<string | 'flush'> = [];
  const headTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${capabilities}\n`);
  } else {
    const headLine = headTip !== undefined ? `${headTip} HEAD\0${capabilities}\n` : null;
    if (headLine !== null) lines.push(headLine);
    let first = headLine === null;
    for (const [name, oid] of refs) {
      if (name === 'HEAD') continue;
      const line = first ? `${oid} ${name}\0${capabilities}\n` : `${oid} ${name}\n`;
      lines.push(line);
      first = false;
      // Peeled line for an annotated tag.
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        lines.push(`${peeled} ${name}^{}\n`);
      }
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/**
 * GET /{owner}/{repo}.git/info/refs?service=... — the advertisement. v2
 * when the client asked for it (upload-pack only), v0 otherwise. The
 * `# service=` preamble opens the body, as real git servers send it.
 */
export function handleInfoRefs(store: ForgeStore, req: GitRequest, res: GitResponder): void {
  if (!store.resolveOwner(req.owner)) return notFound(res, 'repository not found');
  const repo = store.getRepo(req.repoName);
  if (repo === undefined || repo.owner !== req.owner) return notFound(res, 'repository not found');
  const service = req.query.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return badRequest(res, 'unknown service');
  }
  const advertisementType = `application/x-${service}-advertisement`;
  if (service === 'git-receive-pack' || !req.wantsV2) {
    const caps = service === 'git-receive-pack' ? v0ReceiveCapabilities() : v0UploadCapabilities();
    const preamble = encodePktLines([`# service=${service}\n`, 'flush']);
    res.send(200, advertisementType, Buffer.concat([preamble, v0Advertisement(repo, caps)]));
    return;
  }
  const preamble = encodePktLines([`# service=${service}\n`, 'flush']);
  const body = encodePktLines([...v2Capabilities(), 'flush']);
  res.send(200, advertisementType, Buffer.concat([preamble, body]));
}

// ---------------------------------------------------------------- ls-refs (v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Parse a v2 ls-refs request body into its arguments. */
function parseLsRefsArgs(packets: PktPacket[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) continue; // command= / agent= / object-format= live before the delim
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

/** One ls-refs response line for a ref, with symref and peeled attributes. */
function lsRefsLine(repo: Repo, name: string, oid: string, args: LsRefsArgs): string {
  const attrs: string[] = [];
  if (args.symrefs && name === 'HEAD') attrs.push('symref-target:refs/heads/main');
  if (args.peel) {
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      attrs.push(`peeled:${peelToCommit(repo, oid)}`);
    }
  }
  return attrs.length > 0 ? `${oid} ${name} ${attrs.join(' ')}\n` : `${oid} ${name}\n`;
}

function handleLsRefs(repo: Repo, packets: PktPacket[], res: GitResponder): void {
  const args = parseLsRefsArgs(packets);
  const lines: Array<string | 'flush'> = [];
  const headTip = repo.refs.get('refs/heads/main');
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (headTip !== undefined && keep('HEAD')) {
    lines.push(lsRefsLine(repo, 'HEAD', headTip, args));
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    lines.push(lsRefsLine(repo, name, oid, args));
  }
  lines.push('flush');
  res.send(200, 'application/x-git-upload-pack-result', encodePktLines(lines));
}

// ---------------------------------------------------------------- fetch (v2 and v0)

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  filter: string | null;
  /** True when the client sent `done`: no further negotiation rounds. */
  done: boolean;
}

/** Parse a v2 fetch request body (after the command line and the delim). */
function parseV2FetchArgs(packets: PktPacket[]): FetchArgs {
  const args: FetchArgs = {
    wants: [],
    haves: [],
    shallow: [],
    depth: null,
    deepenSince: null,
    deepenNot: [],
    filter: null,
    done: false,
  };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) continue;
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line === 'done') args.done = true;
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number(line.slice(7).trim());
      if (Number.isFinite(depth) && depth > 0) args.depth = Math.trunc(depth);
    } else if (line.startsWith('deepen-since ')) {
      const since = Number(line.slice(13).trim());
      if (Number.isFinite(since)) args.deepenSince = since;
    } else if (line.startsWith('deepen-not ')) {
      args.deepenNot.push(line.slice(11).trim());
    } else if (line.startsWith('filter ')) {
      args.filter = line.slice(7).trim();
    }
  }
  return args;
}

/** Parse a v0 fetch request: wants (first section) then haves (second). */
function parseV0FetchArgs(packets: PktPacket[]): FetchArgs {
  const args: FetchArgs = {
    wants: [],
    haves: [],
    shallow: [],
    depth: null,
    deepenSince: null,
    deepenNot: [],
    filter: null,
    done: false,
  };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      const oid = rest.split(' ')[0] as string;
      args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      args.haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      args.shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const depth = Number(line.slice(7).trim());
      if (Number.isFinite(depth) && depth > 0) args.depth = Math.trunc(depth);
    } else if (line.startsWith('deepen-since ')) {
      const since = Number(line.slice(13).trim());
      if (Number.isFinite(since)) args.deepenSince = since;
    } else if (line.startsWith('deepen-not ')) {
      args.deepenNot.push(line.slice(11).trim());
    }
    void section;
  }
  return args;
}

/** The packfile section of a fetch response: sideband band-1 packets. */
function packfileSection(objects: GitObject[]): Buffer[] {
  const pack = writePack(objects);
  return sidebandPackets(1, pack);
}

/**
 * The v2 fetch response. Real git's fetch-pack is strict about sections:
 * when the client sent `done` there is no negotiation round, so the
 * response carries NO acknowledgments section — it goes straight to
 * [shallow-info] and then packfile. When the client did not send `done`
 * (it still has haves to negotiate), the response carries the
 * acknowledgments section: ACK for each have reachable from a want (NAK
 * when none is), plus `ready` — this server computes the whole pack in one
 * shot, so it is always ready — and the section ends with a delim so the
 * packfile sections follow in the same response.
 */
function handleFetchV2(store: ForgeStore, repo: Repo, args: FetchArgs, res: GitResponder): void {
  const plan = store.planFetch(repo, args.wants, args.haves, args.shallow, args.depth, args.deepenSince, args.deepenNot);
  const parts: Buffer[] = [];
  if (!args.done) {
    const reachable = new Set<string>();
    for (const want of args.wants) {
      for (const oid of store.walkCommits(repo, store.peelToCommit(repo, want))) reachable.add(oid);
    }
    const ackLines: string[] = ['acknowledgments\n'];
    let acked = 0;
    for (const have of args.haves) {
      const peeled = store.peelToCommit(repo, have);
      if (reachable.has(peeled)) {
        ackLines.push(`ACK ${peeled}\n`);
        acked += 1;
      }
    }
    if (acked === 0) ackLines.push('NAK\n');
    ackLines.push('ready\n');
    ackLines.push('delim');
    parts.push(encodePktLines(ackLines));
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    parts.push(encodePktLines(lines));
  }
  parts.push(encodePktLines(['packfile\n']));
  for (const packet of packfileSection(plan.objects)) parts.push(packet);
  parts.push(Buffer.from('0000', 'ascii'));
  res.send(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** The v0 fetch response: NAK, then sideband pack packets, then flush. */
function handleFetchV0(store: ForgeStore, repo: Repo, args: FetchArgs, res: GitResponder): void {
  const plan = store.planFetch(repo, args.wants, args.haves, args.shallow, args.depth, args.deepenSince, args.deepenNot);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const packet of packfileSection(plan.objects)) parts.push(packet);
  parts.push(Buffer.from('0000', 'ascii'));
  res.send(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/**
 * POST /{owner}/{repo}.git/git-upload-pack — a v2 command (ls-refs or fetch)
 * when the client sent the v2 header, else the v0 want/have exchange.
 */
export function handleUploadPack(store: ForgeStore, req: GitRequest, res: GitResponder): void {
  if (!store.resolveOwner(req.owner)) return notFound(res, 'repository not found');
  const repo = store.getRepo(req.repoName);
  if (repo === undefined || repo.owner !== req.owner) return notFound(res, 'repository not found');
  let packets: PktPacket[];
  try {
    packets = decodePktLines(req.body);
  } catch (err) {
    return badRequest(res, `malformed pkt-line: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (req.wantsV2) {
    const first = packets.find((packet) => packet.kind === 'data');
    const command = first === undefined ? '' : first.payload.toString('utf8').replace(/\n$/, '');
    if (command === 'command=ls-refs') return handleLsRefs(repo, packets, res);
    if (command === 'command=fetch') {
      const args = parseV2FetchArgs(packets);
      if (args.wants.length === 0) return badRequest(res, 'fetch without a want');
      return handleFetchV2(store, repo, args, res);
    }
    return badRequest(res, `unknown upload-pack command ${JSON.stringify(command)}`);
  }
  const args = parseV0FetchArgs(packets);
  if (args.wants.length === 0) return badRequest(res, 'fetch without a want');
  return handleFetchV0(store, repo, args, res);
}

// ---------------------------------------------------------------- receive-pack (v0)

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/**
 * POST /{owner}/{repo}.git/git-receive-pack — v0 only. The body is the
 * pkt-lined command list, a flush, then the pack (absent for a delete-only
 * list). Each ref is applied or refused on its own; the report-status stream
 * travels inside sideband band 1.
 */
export function handleReceivePack(store: ForgeStore, req: GitRequest, res: GitResponder): void {
  if (!store.resolveOwner(req.owner)) return notFound(res, 'repository not found');
  const repo = store.getRepo(req.repoName);
  if (repo === undefined || repo.owner !== req.owner) return notFound(res, 'repository not found');
  let commands: PushCommand[];
  let packBytes: Buffer;
  try {
    const { packets, rest } = splitAtFlush(req.body);
    commands = [];
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8');
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
      line = line.replace(/\n$/, '');
      if (line === '') continue;
      const parts = line.split(' ');
      if (parts.length < 3) throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
      const [oldOid, newOid, ref] = parts as [string, string, string];
      if (!isOid(oldOid) || !isOid(newOid) || !ref.startsWith('refs/')) {
        throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
      }
      commands.push({ oldOid, newOid, ref });
    }
    packBytes = rest;
  } catch (err) {
    return badRequest(res, `malformed pkt-line: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (commands.length === 0) return badRequest(res, 'push without commands');
  // Unpack first: a refused update still unpacks, and a corrupt pack fails
  // the whole push before any ref moves.
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (updatesRef) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const read = readPack(packBytes, (oid) => repo.objects.get(oid));
        for (const [oid, object] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        // The report is line-oriented: flatten any multi-line error.
        unpackDetail = (err instanceof Error ? err.message : 'unpacker error').replace(/\s+/g, ' ').trim();
      }
    }
  }
  const reportLines: Array<string | 'flush'> = [];
  reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
  if (unpackOk) {
    for (const command of commands) {
      const applied = store.applyPushCommand(repo, command);
      if (applied.ok) reportLines.push(`ok ${command.ref}\n`);
      else reportLines.push(`ng ${command.ref} ${applied.reason}\n`);
    }
  } else {
    for (const command of commands) {
      reportLines.push(`ng ${command.ref} unpacker error\n`);
    }
  }
  reportLines.push('flush');
  const report = encodePktLines(reportLines);
  const parts: Buffer[] = [];
  for (const packet of sidebandPackets(1, report)) parts.push(packet);
  parts.push(Buffer.from('0000', 'ascii'));
  res.send(200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
}
