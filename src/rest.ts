// REST v3 API under /api/v3: repositories, branches, commits, file contents,
// labels, issues and pull requests.
//
// Every reply is JSON, never HTML, and carries a non-empty
// X-GitHub-Request-Id (the server adds it). Error bodies carry a string
// `message`. Unknown routes are JSON 404s; malformed JSON bodies are 400s.
// Missing or wrong bearer tokens are 401s (the server checks auth before
// routing, except for /healthz).

import { isOid, parseCommit } from './gitobjects.ts';
import { sortedRefs } from './store.ts';
import type { Reply } from './respond.ts';
import type { ForgeStore, Issue, PullRequest, Repo, RepoView } from './store.ts';

/** What the server hands the REST handlers: method, path segments, query, body. */
export interface RestRequest {
  readonly method: string;
  /** Path segments after /api/v3 (decoded, without empty segments). */
  readonly segments: string[];
  readonly query: URLSearchParams;
  /** The parsed JSON body, or null when there is none / it is not JSON. */
  readonly body: unknown;
  /** True when the body was present but not valid JSON. */
  readonly bodyMalformed: boolean;
  /** The request's Host header value, for absolute pagination links. */
  readonly host: string;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}


function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Split an identity line `Name <email> ts +0000` into its parts. */
function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
}

/** The request's JSON body as an object ({} when absent); null when malformed. */
function bodyObject(req: RestRequest): JsonObject | null {
  if (req.bodyMalformed) return null;
  if (req.body === null || req.body === undefined) return {};
  return asObject(req.body);
}

function err(reply: Reply, status: number, message: string): void {
  reply.json(status, { message });
}

/** A repository's JSON shape. */
export function repoJson(view: RepoView): JsonObject {
  return {
    id: view.id,
    name: view.name,
    full_name: view.fullName,
    owner: { login: view.ownerLogin },
    private: view.private,
    description: view.description,
    default_branch: view.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    created_at: view.createdAt,
    updated_at: view.updatedAt,
  };
}

/** An issue's JSON shape. */
export function issueJson(issue: Issue, ownerLogin: string): JsonObject {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: ownerLogin },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

/** A comment's JSON shape. */
function commentJson(comment: { id: number; body: string; createdAt: string }, ownerLogin: string): JsonObject {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: ownerLogin },
    created_at: comment.createdAt,
  };
}

/** A pull request's JSON shape. */
export function pullJson(pull: PullRequest, ownerLogin: string): JsonObject {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${ownerLogin}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${ownerLogin}:${pull.baseRef}` },
    user: { login: ownerLogin },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

/**
 * Resolve the owner and repository named by the path. Returns null after
 * answering 404 when the owner is foreign or the repository is absent.
 */
function resolveRepo(
  store: ForgeStore,
  reply: Reply,
  owner: string,
  name: string,
): Repo | null {
  if (!store.resolveOwner(owner)) {
    err(reply, 404, 'repository not found');
    return null;
  }
  const repo = store.getRepo(name);
  if (repo === undefined || repo.owner !== owner) {
    err(reply, 404, 'repository not found');
    return null;
  }
  return repo;
}

/** Parse a positive page size: default 30, capped at 100. */
function pageSize(query: URLSearchParams): number {
  const raw = Number(query.get('per_page') ?? '');
  if (!Number.isFinite(raw) || raw <= 0) return 30;
  return Math.min(100, Math.trunc(raw));
}

/** Parse a 1-based page number, defaulting to 1. */
function pageNumber(query: URLSearchParams): number {
  const raw = Number(query.get('page') ?? '');
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.trunc(raw);
}

/** The absolute URL for a page of a listing (same origin as the request). */
function pageUrl(req: RestRequest, path: string, page: number, perPage: number): string {
  return `http://${req.host}${path}?per_page=${perPage}&page=${page}`;
}

/** The main entry point: dispatch a REST request by method and segments. */
export function handleRest(store: ForgeStore, req: RestRequest, reply: Reply): void {
  const segments = req.segments;
  const method = req.method;

  // GET /api/v3/ — the root: 200 JSON plus the scopes header.
  if (segments.length === 0) {
    if (method !== 'GET') return err(reply, 404, 'not found');
    reply.header('X-OAuth-Scopes', 'repo, read:org');
    reply.json(200, {});
    return;
  }

  // GET /api/v3/meta — the installed version.
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return err(reply, 404, 'not found');
    reply.json(200, { installed_version: '1.0.0' });
    return;
  }

  // GET /api/v3/user — the token owner (401 while the viewer is unbound).
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return err(reply, 404, 'not found');
    if (store.viewerLogin === null) return err(reply, 401, 'viewer not bound');
    reply.json(200, { login: store.viewerLogin });
    return;
  }

  // /api/v3/user/repos — create, and the paged viewer listing.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') return createUserRepo(store, req, reply);
    if (method === 'GET') return listUserRepos(store, req, reply);
    return err(reply, 404, 'not found');
  }

  // /api/v3/repos/{owner}/{name}[/...] — everything repository-scoped.
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const rest = segments.slice(3);
    return handleRepoScoped(store, req, reply, owner, name, rest);
  }

  return err(reply, 404, 'not found');
}

function createUserRepo(store: ForgeStore, req: RestRequest, reply: Reply): void {
  const body = bodyObject(req);
  if (body === null) return err(reply, 400, 'malformed JSON body');
  const name = asString(body.name);
  if (name === undefined || name === '') return err(reply, 422, 'name is required');
  const result = store.createRepo(name, {
    private: asBoolean(body.private),
    description: asString(body.description),
  });
  if ('error' in result) return err(reply, 422, result.error);
  reply.json(201, repoJson(store.repoView(result.repo)));
}

function listUserRepos(store: ForgeStore, req: RestRequest, reply: Reply): void {
  const perPage = pageSize(req.query);
  const page = pageNumber(req.query);
  const repos = store.viewerRepos();
  const totalPages = Math.max(1, Math.ceil(repos.length / perPage));
  const start = (page - 1) * perPage;
  const items = repos.slice(start, start + perPage);
  if (page < totalPages) {
    reply.header('Link', `<${pageUrl(req, '/api/v3/user/repos', page + 1, perPage)}>; rel="next"`);
  }
  reply.json(200, items.map((repo) => repoJson(store.repoView(repo))));
}

function handleRepoScoped(
  store: ForgeStore,
  req: RestRequest,
  reply: Reply,
  owner: string,
  name: string,
  rest: string[],
): void {
  const method = req.method;

  // The repository itself: GET, PATCH, DELETE.
  if (rest.length === 0) {
    if (method === 'GET') {
      const repo = resolveRepo(store, reply, owner, name);
      if (repo === null) return;
      reply.json(200, repoJson(store.repoView(repo)));
      return;
    }
    if (method === 'PATCH') {
      const repo = resolveRepo(store, reply, owner, name);
      if (repo === null) return;
      const body = bodyObject(req);
      if (body === null) return err(reply, 400, 'malformed JSON body');
      const description = asString(body.description);
      if (description !== undefined) repo.description = description;
      const isPrivate = asBoolean(body.private);
      if (isPrivate !== undefined) repo.private = isPrivate;
      repo.updatedAt = store.clock.nowIso;
      reply.json(200, repoJson(store.repoView(repo)));
      return;
    }
    if (method === 'DELETE') {
      const repo = resolveRepo(store, reply, owner, name);
      if (repo === null) return;
      store.deleteRepo(name);
      reply.noContent();
      return;
    }
    return err(reply, 404, 'not found');
  }

  const head = rest[0] as string;

  // Branches: GET /branches, GET /branches/{branch}.
  if (head === 'branches') {
    const repo = resolveRepo(store, reply, owner, name);
    if (repo === null) return;
    if (method !== 'GET') return err(reply, 404, 'not found');
    if (rest.length === 1) {
      const branches: JsonObject[] = [];
      for (const [refName, oid] of sortedRefs(repo)) {
        if (!refName.startsWith('refs/heads/')) continue;
        branches.push({ name: refName.slice('refs/heads/'.length), commit: { sha: oid } });
      }
      reply.json(200, branches);
      return;
    }
    if (rest.length === 2) {
      const branch = rest[1] as string;
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) return err(reply, 404, 'branch not found');
      reply.json(200, { name: branch, commit: { sha: oid } });
      return;
    }
    return err(reply, 404, 'not found');
  }

  // Git refs: POST /git/refs, GET /git/refs/heads/{branch}.
  if (head === 'git' && rest[1] === 'refs') {
    const repo = resolveRepo(store, reply, owner, name);
    if (repo === null) return;
    if (method === 'POST' && rest.length === 2) {
      const body = bodyObject(req);
      if (body === null) return err(reply, 400, 'malformed JSON body');
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (ref === undefined || sha === undefined) return err(reply, 422, 'ref and sha are required');
      if (!ref.startsWith('refs/')) return err(reply, 422, 'ref must start with refs/');
      if (repo.refs.has(ref)) return err(reply, 422, 'reference already exists');
      if (!isOid(sha) || !repo.objects.has(sha)) return err(reply, 422, 'unknown object');
      repo.refs.set(ref, sha);
      reply.json(201, { ref, object: { sha } });
      return;
    }
    if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
      const branch = rest[3] as string;
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) return err(reply, 404, 'reference not found');
      reply.json(200, { ref: `refs/heads/${branch}`, object: { sha: oid } });
      return;
    }
    return err(reply, 404, 'not found');
  }

  // Commits: GET /commits[?sha=<ref>].
  if (head === 'commits') {
    const repo = resolveRepo(store, reply, owner, name);
    if (repo === null) return;
    if (method !== 'GET' || rest.length !== 1) return err(reply, 404, 'not found');
    const ref = req.query.get('sha') ?? undefined;
    const tip = ref === undefined ? store.defaultTip(repo) : store.resolveRef(repo, ref);
    if (tip === null) {
      reply.json(200, []);
      return;
    }
    const peeled = store.peelToCommit(repo, tip);
    const commits = store.walkCommits(repo, peeled).map((oid) => {
      const object = repo.objects.get(oid);
      const parsed = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
      return {
        sha: oid,
        commit: {
          message: parsed?.message ?? '',
          author: parsed ? parseIdentity(parsed.author) : { name: '', email: '', date: store.clock.nowIso },
          committer: parsed ? parseIdentity(parsed.committer) : { name: '', email: '', date: store.clock.nowIso },
        },
        parents: (parsed?.parents ?? []).map((sha) => ({ sha })),
      };
    });
    reply.json(200, commits);
    return;
  }

  // Contents: PUT/GET/DELETE /contents/{path...}.
  if (head === 'contents') {
    const repo = resolveRepo(store, reply, owner, name);
    if (repo === null) return;
    const path = rest.slice(1).join('/');
    if (method === 'PUT') return putContents(store, req, reply, repo, path);
    if (method === 'GET') return getContents(store, req, reply, repo, path);
    if (method === 'DELETE') return deleteContents(store, req, reply, repo, path);
    return err(reply, 404, 'not found');
  }

  // Labels: POST /labels, GET /labels.
  if (head === 'labels') {
    const repo = resolveRepo(store, reply, owner, name);
    if (repo === null) return;
    if (method === 'POST' && rest.length === 1) {
      const body = bodyObject(req);
      if (body === null) return err(reply, 400, 'malformed JSON body');
      const labelName = asString(body.name);
      if (labelName === undefined || labelName === '') return err(reply, 422, 'name is required');
      const label = store.createLabel(repo, labelName, asString(body.color));
      reply.json(201, { name: label.name, color: label.color });
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      reply.json(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
      return;
    }
    return err(reply, 404, 'not found');
  }

  // Issues: POST/GET /issues, GET/PATCH /issues/{n}, comments.
  if (head === 'issues') {
    const repo = resolveRepo(store, reply, owner, name);
    if (repo === null) return;
    return handleIssues(store, req, reply, repo, owner, rest.slice(1));
  }

  // Pulls: POST/GET /pulls, GET /pulls/{n}, GET /pulls/{n}/files, PUT merge.
  if (head === 'pulls') {
    const repo = resolveRepo(store, reply, owner, name);
    if (repo === null) return;
    return handlePulls(store, req, reply, repo, owner, rest.slice(1));
  }

  return err(reply, 404, 'not found');
}

function putContents(
  store: ForgeStore,
  req: RestRequest,
  reply: Reply,
  repo: Repo,
  path: string,
): void {
  const body = bodyObject(req);
  if (body === null) return err(reply, 400, 'malformed JSON body');
  const message = asString(body.message);
  const content = asString(body.content);
  if (message === undefined || content === undefined) {
    return err(reply, 422, 'message and content are required');
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(content, 'base64');
  } catch {
    return err(reply, 422, 'content is not base64');
  }
  const result = store.putContents(repo, path, bytes, message, asString(body.branch), asString(body.sha));
  if ('error' in result) return err(reply, result.status, result.error);
  const name = path.split('/').pop() as string;
  reply.json(result.status, {
    content: { name, path, sha: result.contentSha, size: bytes.length, type: 'file', encoding: 'base64' },
    commit: { sha: result.commitSha, message },
  });
}

function getContents(
  store: ForgeStore,
  req: RestRequest,
  reply: Reply,
  repo: Repo,
  path: string,
): void {
  const ref = req.query.get('ref') ?? undefined;
  const found = store.readContents(repo, path, ref);
  if (found.kind === 'missing') return err(reply, 404, 'path not found');
  if (found.kind === 'file') {
    reply.json(200, {
      type: 'file',
      encoding: 'base64',
      content: found.data.toString('base64'),
      sha: found.sha,
      size: found.size,
      name: found.name,
      path: found.path,
    });
    return;
  }
  reply.json(
    200,
    found.entries.map((entry) => ({
      type: entry.type,
      name: entry.name,
      path: entry.path,
      sha: entry.sha,
      size: entry.size,
    })),
  );
}

function deleteContents(
  store: ForgeStore,
  req: RestRequest,
  reply: Reply,
  repo: Repo,
  path: string,
): void {
  const body = bodyObject(req);
  if (body === null) return err(reply, 400, 'malformed JSON body');
  const message = asString(body.message) ?? '';
  const result = store.deleteContents(repo, path, message, asString(body.branch), asString(body.sha));
  if ('error' in result) return err(reply, result.status, result.error);
  reply.json(200, { commit: { sha: result.commitSha, message } });
}

function handleIssues(
  store: ForgeStore,
  req: RestRequest,
  reply: Reply,
  repo: Repo,
  owner: string,
  rest: string[],
): void {
  const method = req.method;
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = bodyObject(req);
      if (body === null) return err(reply, 400, 'malformed JSON body');
      const title = asString(body.title);
      if (title === undefined || title === '') return err(reply, 422, 'title is required');
      const rawLabels = body.labels;
      const labels: string[] = Array.isArray(rawLabels)
        ? rawLabels.map((entry) => (typeof entry === 'string' ? entry : asString((entry as JsonObject)?.name) ?? '')).filter((entry) => entry !== '')
        : [];
      const result = store.createIssue(repo, { title, body: asString(body.body), labels });
      if ('error' in result) return err(reply, 422, result.error);
      reply.json(201, issueJson(result.issue, owner));
      return;
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const direction = req.query.get('direction') ?? 'desc';
      const issues = store.listIssues(repo, { state, direction });
      reply.json(200, issues.map((issue) => issueJson(issue, owner)));
      return;
    }
    return err(reply, 404, 'not found');
  }
  const number = Number(rest[0]);
  if (!Number.isSafeInteger(number) || number < 1) return err(reply, 404, 'issue not found');
  if (rest.length === 1) {
    if (method === 'GET') {
      const issue = store.getIssue(repo, number);
      if (issue === undefined) return err(reply, 404, 'issue not found');
      reply.json(200, issueJson(issue, owner));
      return;
    }
    if (method === 'PATCH') {
      const body = bodyObject(req);
      if (body === null) return err(reply, 400, 'malformed JSON body');
      const issue = store.patchIssue(repo, number, {
        state: asString(body.state),
        title: asString(body.title),
        body: asString(body.body),
      });
      if (issue === undefined) return err(reply, 404, 'issue not found');
      reply.json(200, issueJson(issue, owner));
      return;
    }
    return err(reply, 404, 'not found');
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') {
      const body = bodyObject(req);
      if (body === null) return err(reply, 400, 'malformed JSON body');
      const commentBody = asString(body.body);
      if (commentBody === undefined) return err(reply, 422, 'body is required');
      const comment = store.createComment(repo, number, commentBody);
      if (comment === undefined) return err(reply, 404, 'issue not found');
      reply.json(201, commentJson(comment, owner));
      return;
    }
    if (method === 'GET') {
      const issue = store.getIssue(repo, number);
      if (issue === undefined) return err(reply, 404, 'issue not found');
      reply.json(200, issue.comments.map((comment) => commentJson(comment, owner)));
      return;
    }
    return err(reply, 404, 'not found');
  }
  return err(reply, 404, 'not found');
}

function handlePulls(
  store: ForgeStore,
  req: RestRequest,
  reply: Reply,
  repo: Repo,
  owner: string,
  rest: string[],
): void {
  const method = req.method;
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = bodyObject(req);
      if (body === null) return err(reply, 400, 'malformed JSON body');
      const title = asString(body.title);
      const head = asString(body.head);
      const base = asString(body.base);
      if (title === undefined || head === undefined || base === undefined) {
        return err(reply, 422, 'title, head and base are required');
      }
      const result = store.createPull(repo, { title, body: asString(body.body), head, base });
      if ('error' in result) return err(reply, result.status, result.error);
      reply.json(201, pullJson(result.pull, owner));
      return;
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const pulls = store.listPulls(repo, state);
      reply.json(200, pulls.map((pull) => pullJson(pull, owner)));
      return;
    }
    return err(reply, 404, 'not found');
  }
  const number = Number(rest[0]);
  if (!Number.isSafeInteger(number) || number < 1) return err(reply, 404, 'pull request not found');
  if (rest.length === 1) {
    if (method === 'GET') {
      const pull = store.getPull(repo, number);
      if (pull === undefined) return err(reply, 404, 'pull request not found');
      reply.json(200, pullJson(pull, owner));
      return;
    }
    return err(reply, 404, 'not found');
  }
  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') return err(reply, 404, 'not found');
    const pull = store.getPull(repo, number);
    if (pull === undefined) return err(reply, 404, 'pull request not found');
    reply.json(200, store.pullFiles(repo, pull));
    return;
  }
  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') return err(reply, 404, 'not found');
    const body = bodyObject(req);
    if (body === null) return err(reply, 400, 'malformed JSON body');
    const mergeMethod = asString(body.merge_method);
    if (mergeMethod !== undefined && mergeMethod !== 'squash') {
      return err(reply, 422, 'only squash merges are supported');
    }
    const result = store.mergePull(repo, number);
    if ('error' in result) return err(reply, result.status, result.error);
    reply.json(200, { sha: result.sha, merged: true, message: result.message });
    return;
  }
  return err(reply, 404, 'not found');
}
