// The HTTP server: one Node http server, routing, auth, and the JSON
// discipline every surface shares.
//
// Routing:
//   GET  /healthz                                   no auth, {"ok": true}
//   /{owner}/{repo}.git/info/refs                   git advertisement
//   /{owner}/{repo}.git/git-upload-pack             git fetch / ls-refs
//   /{owner}/{repo}.git/git-receive-pack            git push
//   /api/v3/...                                     REST v3
//   POST /api/graphql                              GraphQL v4
//   POST /mcp                                      MCP over JSON-RPC 2.0
//
// Auth: every request except /healthz carries `Authorization: Bearer
// <MAKEFUN_SHOP_TOKEN>`; anything else is a JSON 401. Every reply carries
// a non-empty X-GitHub-Request-Id from a deterministic counter (never the
// clock, never Math.random). Malformed JSON bodies on the JSON surfaces are
// 400s; unknown routes are JSON 404s. A handler that throws answers 500
// JSON and the server stays up.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitRequest } from './gitsmart.ts';
import { handleMcp } from './mcp.ts';
import type { Reply } from './respond.ts';
import { handleRest, type RestRequest } from './rest.ts';
import type { ForgeStore } from './store.ts';

export interface ServerOptions {
  readonly token: string;
  readonly host: string;
  readonly port: number;
}

class ReplySink implements Reply {
  private sent = false;
  private readonly res: ServerResponse;
  private readonly requestId: string;

  constructor(res: ServerResponse, requestId: string) {
    this.res = res;
    this.requestId = requestId;
  }

  private writeHead(status: number, contentType: string): void {
    if (this.sent) return;
    this.sent = true;
    this.res.writeHead(status, {
      'Content-Type': contentType,
      'X-GitHub-Request-Id': this.requestId,
    });
  }

  header(name: string, value: string): void {
    if (this.sent) return;
    this.res.setHeader(name, value);
  }

  json(status: number, body: unknown): void {
    const text = JSON.stringify(body);
    this.writeHead(status, 'application/json');
    this.res.end(text);
  }

  send(status: number, contentType: string, body: Buffer): void {
    this.writeHead(status, contentType);
    this.res.end(body);
  }

  noContent(): void {
    this.writeHead(204, 'application/json');
    this.res.end();
  }
}

/** Read the whole request body (binary-safe). Empty body yields an empty buffer. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Split a URL path into decoded segments, dropping empty ones. */
function pathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** Create the forge's HTTP server (not yet listening). */
export function createForgeServer(store: ForgeStore, options: ServerOptions): Server {
  let requestCounter = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const requestId = `req-${(requestCounter += 1)}`;
      const reply = new ReplySink(res, requestId);
      // The request id rides on every reply, including the ones below.
      res.setHeader('X-GitHub-Request-Id', requestId);
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        const segments = pathSegments(url.pathname);
        const method = req.method ?? 'GET';

        // GET /healthz takes no auth.
        if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
          reply.json(200, { ok: true });
          return;
        }

        // Auth: Bearer <token> on everything else.
        const authorization = req.headers.authorization ?? '';
        const expected = `Bearer ${options.token}`;
        if (options.token === '' || authorization !== expected) {
          reply.json(401, { message: 'authentication required' });
          return;
        }

        const body = await readBody(req);
        const host = req.headers.host ?? '127.0.0.1';

        // Git smart HTTP: /{owner}/{repo}.git/<service>.
        if (
          segments.length >= 3 &&
          (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack' || segments[2] === 'info')
        ) {
          const owner = segments[0] as string;
          const repoSegment = segments[1] as string;
          if (!repoSegment.endsWith('.git')) {
            reply.json(404, { message: 'not found' });
            return;
          }
          const repoName = repoSegment.slice(0, -'.git'.length);
          const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
          if (segments[2] === 'info' && segments[3] === 'refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              reply.json(400, { message: 'unknown service' });
              return;
            }
            const gitReq: GitRequest = {
              owner,
              repoName,
              service: service as 'git-upload-pack' | 'git-receive-pack',
              wantsV2,
              query: url.searchParams,
              body,
            };
            handleInfoRefs(store, gitReq, reply);
            return;
          }
          if (segments[2] === 'git-upload-pack' && method === 'POST') {
            handleUploadPack(store, { owner, repoName, service: 'git-upload-pack', wantsV2, query: url.searchParams, body }, reply);
            return;
          }
          if (segments[2] === 'git-receive-pack' && method === 'POST') {
            handleReceivePack(store, { owner, repoName, service: 'git-receive-pack', wantsV2, query: url.searchParams, body }, reply);
            return;
          }
          reply.json(404, { message: 'not found' });
          return;
        }

        // REST v3 under /api/v3.
        if (segments.length >= 1 && segments[0] === 'api' && segments[1] === 'v3') {
          const restReq: RestRequest = {
            method,
            segments: segments.slice(2),
            query: url.searchParams,
            body: parseJsonBody(body),
            bodyMalformed: isMalformedJson(body, method),
            host,
          };
          handleRest(store, restReq, reply);
          return;
        }

        // GraphQL v4 at /api/graphql.
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          if (method !== 'POST') {
            reply.json(404, { message: 'not found' });
            return;
          }
          const parsed = parseJsonBody(body);
          if (parsed === undefined && body.length > 0) {
            reply.json(400, { message: 'malformed JSON body' });
            return;
          }
          handleGraphQL(store, parsed ?? null, reply);
          return;
        }

        // MCP at /mcp.
        if (segments.length === 1 && segments[0] === 'mcp') {
          if (method !== 'POST') {
            reply.json(405, { message: 'method not allowed' });
            return;
          }
          handleMcp(store, body.toString('utf8'), reply);
          return;
        }

        reply.json(404, { message: 'not found' });
      } catch (err) {
        // A handler that throws must not kill the server or the trial.
        try {
          reply.json(500, { message: err instanceof Error ? err.message : 'internal error' });
        } catch {
          try {
            res.destroy();
          } catch {
            // Nothing left to do.
          }
        }
      }
    })();
  });
  return server;
}

/** Parse a request body as JSON: undefined when absent or unparseable. */
function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** True when the request carried a body that is not valid JSON. */
function isMalformedJson(body: Buffer, method: string): boolean {
  if (method === 'GET' || method === 'DELETE') {
    // GETs carry no body; a DELETE may carry a JSON body (contents delete).
    if (method === 'GET') return false;
  }
  if (body.length === 0) return false;
  try {
    JSON.parse(body.toString('utf8'));
    return false;
  } catch {
    return true;
  }
}
