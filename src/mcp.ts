// Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over Streamable
// HTTP, plain JSON answers (no SSE needed), within three seconds.
//
// Two eras are served: the modern 2026-07-28 `server/discover` (no
// handshake, no session) and the legacy `initialize` +
// `notifications/initialized` handshake. Six tools act on the same store as
// REST: create_repo, get_repo, create_issue, list_issues,
// create_pull_request, merge_pull_request. Tool results carry both a text
// JSON body and structuredContent. Unknown tools and missing required
// arguments are JSON-RPC errors (-32601 / -32602), never HTTP 500; a
// non-JSON body is HTTP 400 with the parse-error code -32700; a call with
// no authorization header is 401 (the server enforces that before this
// handler).

import type { Reply } from './respond.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import type { ForgeStore, Repo } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, Record<string, string>>;
    readonly required: string[];
  };
}

/** The tool list, built once: two tools/list calls answer byte for byte. */
const TOOLS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (ignored: repositories belong to the authenticated user).' },
      },
      required: ['name'],
    },
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List a repository issues, optionally filtered by state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  }),
]);

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

function serverInfo(): { name: string; version: string } {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

/** A tool result: text JSON plus structured content. */
function toolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: value,
    isError: false,
  };
}

/** A tool execution failure: isError with a text message. */
function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return undefined;
}

/** Resolve the owner and repository for a tool call, or an error message. */
function resolveToolRepo(
  store: ForgeStore,
  args: Record<string, unknown>,
): { repo: Repo; owner: string } | { error: string } {
  const owner = asString(args.owner);
  const repoName = asString(args.repo) ?? asString(args.repository);
  if (owner === undefined || repoName === undefined) return { error: 'owner and repo are required' };
  if (!store.resolveOwner(owner)) return { error: 'repository not found' };
  const repo = store.getRepo(repoName);
  if (repo === undefined || repo.owner !== owner) return { error: 'repository not found' };
  return { repo, owner };
}

function callCreateRepo(store: ForgeStore, args: Record<string, unknown>): Record<string, unknown> {
  const name = asString(args.name);
  if (name === undefined || name === '') return toolError('name is required');
  const result = store.createRepo(name, {
    private: typeof args.private === 'boolean' ? args.private : undefined,
    description: asString(args.description),
  });
  if ('error' in result) return toolError(result.error);
  return toolResult(repoJson(store.repoView(result.repo)));
}

function callGetRepo(store: ForgeStore, args: Record<string, unknown>): Record<string, unknown> {
  const resolved = resolveToolRepo(store, args);
  if ('error' in resolved) return toolError(resolved.error);
  return toolResult(repoJson(store.repoView(resolved.repo)));
}

function callCreateIssue(store: ForgeStore, args: Record<string, unknown>): Record<string, unknown> {
  const resolved = resolveToolRepo(store, args);
  if ('error' in resolved) return toolError(resolved.error);
  const title = asString(args.title);
  if (title === undefined || title === '') return toolError('title is required');
  const result = store.createIssue(resolved.repo, { title, body: asString(args.body) });
  if ('error' in result) return toolError(result.error);
  return toolResult(issueJson(result.issue, resolved.owner));
}

function callListIssues(store: ForgeStore, args: Record<string, unknown>): Record<string, unknown> {
  const resolved = resolveToolRepo(store, args);
  if ('error' in resolved) return toolError(resolved.error);
  const state = asString(args.state) ?? 'open';
  const issues = store.listIssues(resolved.repo, { state, direction: 'desc' });
  const list = issues.map((issue) => issueJson(issue, resolved.owner));
  return {
    content: [{ type: 'text', text: JSON.stringify(list) }],
    structuredContent: { issues: list },
    isError: false,
  };
}

function callCreatePullRequest(store: ForgeStore, args: Record<string, unknown>): Record<string, unknown> {
  const resolved = resolveToolRepo(store, args);
  if ('error' in resolved) return toolError(resolved.error);
  const title = asString(args.title);
  const head = asString(args.head);
  const base = asString(args.base);
  if (title === undefined || head === undefined || base === undefined) {
    return toolError('title, head and base are required');
  }
  const result = store.createPull(resolved.repo, { title, body: asString(args.body), head, base });
  if ('error' in result) return toolError(result.error);
  return toolResult(pullJson(result.pull, resolved.owner));
}

function callMergePullRequest(store: ForgeStore, args: Record<string, unknown>): Record<string, unknown> {
  const resolved = resolveToolRepo(store, args);
  if ('error' in resolved) return toolError(resolved.error);
  const number = asInteger(args.pull_number) ?? asInteger(args.number);
  if (number === undefined) return toolError('pull_number is required');
  const result = store.mergePull(resolved.repo, number);
  if ('error' in result) return toolError(result.error);
  const pull = resolved.repo.pulls.get(number);
  if (pull === undefined) return toolError('pull request not found');
  return toolResult({ merged: true, sha: result.sha, message: result.message, number });
}

/** Dispatch a tools/call by name. Assumes required arguments were checked. */
function dispatchTool(
  store: ForgeStore,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  switch (name) {
    case 'create_repo':
      return callCreateRepo(store, args);
    case 'get_repo':
      return callGetRepo(store, args);
    case 'create_issue':
      return callCreateIssue(store, args);
    case 'list_issues':
      return callListIssues(store, args);
    case 'create_pull_request':
      return callCreatePullRequest(store, args);
    case 'merge_pull_request':
      return callMergePullRequest(store, args);
    default:
      return toolError(`unknown tool ${name}`);
  }
}

/** The handler: POST /mcp with a JSON-RPC 2.0 body (raw text for parse errors). */
export function handleMcp(store: ForgeStore, rawBody: string, reply: Reply): void {
  let request: unknown;
  try {
    request = JSON.parse(rawBody);
  } catch {
    reply.json(400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    return;
  }
  const record = asRecord(request);
  if (record === null) {
    reply.json(400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' },
    });
    return;
  }
  const id = record.id === undefined ? undefined : record.id;
  const method = asString(record.method);
  // A notification (no id) is answered 202 with an empty body.
  if (id === undefined) {
    if (method === 'notifications/initialized') {
      reply.send(202, 'application/json', Buffer.alloc(0));
      return;
    }
    reply.send(202, 'application/json', Buffer.alloc(0));
    return;
  }
  const result = (value: unknown): void => {
    reply.json(200, { jsonrpc: '2.0', id, result: value });
  };
  const error = (code: number, message: string): void => {
    reply.json(200, { jsonrpc: '2.0', id, error: { code, message } });
  };
  if (method === undefined) return error(-32600, 'Invalid Request: method is required');
  if (method === 'server/discover') {
    const info = serverInfo();
    return result({
      serverInfo: info,
      capabilities: { tools: {} },
      supportedVersions: [MODERN_REVISION, ...LEGACY_REVISIONS],
      _meta: { 'io.modelcontextprotocol/serverInfo': info },
    });
  }
  if (method === 'initialize') {
    const params = asRecord(record.params) ?? {};
    const requested = asString(params.protocolVersion);
    if (requested !== null && requested !== undefined && !LEGACY_REVISIONS.includes(requested) && requested !== MODERN_REVISION) {
      return error(-32602, `unsupported protocol version ${requested}`);
    }
    return result({
      protocolVersion: requested ?? MODERN_REVISION,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
    });
  }
  if (method === 'ping') return result({});
  if (method === 'tools/list') {
    return result({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const params = asRecord(record.params);
    if (params === null) return error(-32602, 'tools/call needs params');
    const name = asString(params.name);
    if (name === undefined || name === '') return error(-32602, 'tools/call needs a tool name');
    if (!TOOL_NAMES.has(name)) return error(-32601, `unknown tool ${name}`);
    const tool = TOOLS.find((candidate) => candidate.name === name) as ToolDefinition;
    const args = asRecord(params.arguments) ?? {};
    for (const required of tool.inputSchema.required) {
      if (args[required] === undefined || args[required] === null) {
        return error(-32602, `missing required argument ${required}`);
      }
    }
    return result(dispatchTool(store, name, args));
  }
  return error(-32601, `unknown method ${method}`);
}
