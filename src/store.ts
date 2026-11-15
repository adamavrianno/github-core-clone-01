// The forge's in-memory store: repositories with their git objects, refs,
// issues, pull requests, labels and file contents, all in one process, no
// database and no files. Every surface (git smart HTTP, REST v3, GraphQL v4,
// MCP) reads and writes this same store, so an object created through one
// surface reads back identically through the others.
//
// Numbering: issues and pull requests share one counter per repository,
// starting at 1 (GitHub semantics). Repository databaseIds and the stable
// numeric ids of issues and comments come from process-wide counters, so
// they are stable across reads and deterministic for a given request order.

import type { TrialClock } from './determinism.ts';
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  identityLine,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
} from './gitobjects.ts';

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  state: 'open' | 'closed';
  readonly labels: Label[];
  readonly createdAt: string;
  updatedAt: string;
  readonly comments: IssueComment[];
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Repo {
  readonly name: string;
  /** Null until the viewer login is bound; then the viewer's login. */
  owner: string | null;
  private: boolean;
  description: string;
  readonly defaultBranch: string;
  readonly databaseId: number;
  readonly createdAt: string;
  updatedAt: string;
  /** Objects by id: commits, trees, blobs, tags. */
  readonly objects: Map<string, GitObject>;
  /** Full ref names (refs/heads/..., refs/tags/...) to tip ids. */
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  /** Shared issues+pulls numbering counter (next number to hand out). */
  numberCounter: number;
  commentCounter: number;
}

export interface RepoView {
  readonly id: number;
  readonly name: string;
  readonly fullName: string;
  readonly ownerLogin: string;
  readonly private: boolean;
  readonly description: string;
  readonly defaultBranch: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a contents read finds: a file, a directory listing, or nothing. */
export type ContentsEntry =
  | { readonly kind: 'file'; readonly name: string; readonly path: string; readonly sha: string; readonly size: number; readonly data: Buffer }
  | { readonly kind: 'dir'; readonly entries: Array<{ name: string; path: string; sha: string; type: 'file' | 'dir'; size: number }> }
  | { readonly kind: 'missing' };

/** One changed path in a pull request's diff, with line counts. */
export interface PullFile {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

const DEFAULT_LABEL_COLOR = 'ededed';

/** Flatten a tree into path -> {mode, oid}, following nested trees. */
function flattenTree(
  objects: Map<string, GitObject>,
  treeOid: string,
  prefix: string,
  out: Map<string, { mode: string; oid: string }>,
): void {
  const tree = objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(objects, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
}

/**
 * Build nested tree objects for a flat path -> blob map, storing each tree
 * in the repo's object map. Returns the root tree's id.
 */
function buildNestedTrees(
  objects: Map<string, GitObject>,
  files: Map<string, { mode: string; oid: string }>,
): string {
  // Group paths by their first segment, recursively.
  const buildLevel = (paths: Array<{ segments: string[]; mode: string; oid: string }>): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    const dirs = new Map<string, Array<{ segments: string[]; mode: string; oid: string }>>();
    for (const item of paths) {
      if (item.segments.length === 1) {
        entries.push({ mode: item.mode, name: item.segments[0] as string, oid: item.oid });
      } else {
        const head = item.segments[0] as string;
        const rest = dirs.get(head) ?? [];
        rest.push({ segments: item.segments.slice(1), mode: item.mode, oid: item.oid });
        dirs.set(head, rest);
      }
    }
    for (const [name, children] of dirs) {
      entries.push({ mode: '40000', name, oid: buildLevel(children) });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    objects.set(oid, { type: 'tree', data });
    return oid;
  };
  const paths = [...files.entries()].map(([path, value]) => ({
    segments: path.split('/'),
    mode: value.mode,
    oid: value.oid,
  }));
  return buildLevel(paths);
}

/** Count added/removed lines between two texts (multiset line difference). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const countLines = (text: string): Map<string, number> => {
    const counts = new Map<string, number>();
    if (text === '') return counts;
    for (const line of text.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const oldCounts = countLines(oldText);
  const newCounts = countLines(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) {
    const old = oldCounts.get(line) ?? 0;
    if (count > old) additions += count - old;
  }
  for (const [line, count] of oldCounts) {
    const fresh = newCounts.get(line) ?? 0;
    if (count > fresh) deletions += count - fresh;
  }
  return { additions, deletions };
}

export class ForgeStore {
  readonly clock: TrialClock;
  /** The login the bearer token names, once any owner-scoped request binds it. */
  viewerLogin: string | null = null;
  /** Repositories by name (names are unique across viewer and pending). */
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;

  constructor(clock: TrialClock) {
    this.clock = clock;
  }

  // ------------------------------------------------------------ viewer binding

  /**
   * Bind the viewer login from the first owner-scoped request. All pending
   * repositories (created ownerless through POST /user/repos before any
   * owner was known) are assigned to the viewer at bind time: the suite
   * always presents the viewer first, and every repository belongs to them.
   */
  bindViewer(login: string): void {
    if (this.viewerLogin !== null) return;
    this.viewerLogin = login;
    for (const repo of this.repos.values()) {
      if (repo.owner === null) repo.owner = login;
    }
  }

  /**
   * True when `owner` is the viewer (binding on first sight), false for any
   * other owner: a repository under another owner is not-found, never
   * forbidden.
   */
  resolveOwner(owner: string): boolean {
    if (this.viewerLogin === null) {
      this.bindViewer(owner);
      return true;
    }
    return owner === this.viewerLogin;
  }

  /** The identity server-created commits carry: the viewer, trial time. */
  viewerIdentity(): { name: string; email: string } {
    const login = this.viewerLogin ?? 'forge';
    return { name: login, email: `${login}@users.noreply.github.com` };
  }

  // ------------------------------------------------------------ repositories

  createRepo(
    name: string,
    options: { private?: boolean; description?: string } = {},
  ): { repo: Repo } | { error: string } {
    if (name === '' || /[/\s]/.test(name)) return { error: 'invalid repository name' };
    const existing = this.repos.get(name);
    if (existing !== undefined) return { error: 'Repository already exists' };
    const now = this.clock.nowIso;
    const repo: Repo = {
      name,
      owner: this.viewerLogin,
      private: options.private ?? false,
      description: options.description ?? '',
      defaultBranch: 'main',
      databaseId: this.nextRepoId,
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      numberCounter: 1,
      commentCounter: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return { repo };
  }

  /** A repository by name, regardless of owner (the caller checks the owner). */
  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  /** Viewer-owned repositories, in creation order. */
  viewerRepos(): Repo[] {
    const viewer = this.viewerLogin;
    return [...this.repos.values()].filter((repo) => repo.owner !== null && repo.owner === viewer);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  repoView(repo: Repo): RepoView {
    const ownerLogin = repo.owner ?? this.viewerLogin ?? '';
    return {
      id: repo.databaseId,
      name: repo.name,
      fullName: `${ownerLogin}/${repo.name}`,
      ownerLogin,
      private: repo.private,
      description: repo.description,
      defaultBranch: repo.defaultBranch,
      createdAt: repo.createdAt,
      updatedAt: repo.updatedAt,
    };
  }

  // ------------------------------------------------------------ refs and objects

  /** Resolve a branch name, full ref, or object id to a tip id, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    if (isOid(ref) && repo.objects.has(ref)) return ref;
    return null;
  }

  /** The default branch's tip, or null when the repository is empty. */
  defaultTip(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  /** Peel an annotated tag to its target commit, following tag objects. */
  peelToCommit(repo: Repo, oid: string): string {
    return peelToCommit(repo, oid);
  }

  /** The commit a tag object ultimately points at (itself when already one). */
  tagTarget(repo: Repo, tagOid: string): string | null {
    const object = repo.objects.get(tagOid);
    if (object === undefined || object.type !== 'tag') return null;
    return this.peelToCommit(repo, parseTag(object.data).object);
  }

  /**
   * Walk commits from a tip, newest-first (children before parents), each
   * commit once. Merge commits list their parents in stored order.
   */
  walkCommits(repo: Repo, tip: string): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      order.push(oid);
      const parsed = parseCommit(object.data);
      for (let i = parsed.parents.length - 1; i >= 0; i -= 1) {
        stack.push(parsed.parents[i] as string);
      }
    }
    return order;
  }

  /** Every object id reachable from a commit (itself, its tree, its blobs). */
  reachableObjectIds(repo: Repo, commitOid: string): Set<string> {
    const ids = new Set<string>();
    const commits = this.walkCommits(repo, commitOid);
    for (const oid of commits) {
      ids.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const tree = parseCommit(object.data).tree;
      this.collectTreeIds(repo, tree, ids);
    }
    return ids;
  }

  private collectTreeIds(repo: Repo, treeOid: string, out: Set<string>): void {
    if (out.has(treeOid)) return;
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    out.add(treeOid);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') this.collectTreeIds(repo, entry.oid, out);
      else out.add(entry.oid);
    }
  }

  /** The flat file map at a commit: path -> {mode, oid}. */
  filesAtCommit(repo: Repo, commitOid: string): Map<string, { mode: string; oid: string }> {
    const files = new Map<string, { mode: string; oid: string }>();
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return files;
    flattenTree(repo.objects, parseCommit(object.data).tree, '', files);
    return files;
  }

  /** The flat file map at a tree id. */
  filesAtTree(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
    const files = new Map<string, { mode: string; oid: string }>();
    flattenTree(repo.objects, treeOid, '', files);
    return files;
  }

  /** The first common ancestor of two commits (BFS from both sides), or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const fromA = new Set(this.walkCommits(repo, a));
    const queue: string[] = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (fromA.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return null;
  }

  /** True when `ancestor` is reachable from `descendant` (or they are equal). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.walkCommits(repo, descendant).includes(ancestor);
  }

  // ------------------------------------------------------------ contents

  /**
   * Create a commit on a branch from a flat file map. Stores the objects.
   * `parent` is the commit the new one descends from (null for a root
   * commit); callers pass the branch tip, or the default tip when the
   * branch is being created.
   */
  createFileCommit(
    repo: Repo,
    branch: string,
    files: Map<string, { mode: string; oid: string }>,
    message: string,
    parent: string | null,
  ): string {
    const treeOid = buildNestedTrees(repo.objects, files);
    const tip = parent;
    const identity = this.viewerIdentity();
    const line = identityLine(identity.name, identity.email, this.clock.nowSec);
    const commit = buildCommit({
      tree: treeOid,
      parents: tip === null ? [] : [tip],
      author: line,
      committer: line,
      message,
    });
    const commitOid = hashObject('commit', commit);
    repo.objects.set(commitOid, { type: 'commit', data: commit });
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return commitOid;
  }

  /**
   * Write one file through the contents API: creates or updates the file on
   * the branch (creating the branch at the default tip when it does not
   * exist yet), and returns the new blob and commit ids. A stale `sha`
   * (one that is not the file's current blob) is a 409.
   */
  putContents(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch: string | undefined,
    sha: string | undefined,
  ): { status: 201 | 200; contentSha: string; commitSha: string } | { status: 409; error: string } {
    const targetBranch = branch ?? repo.defaultBranch;
    let tip = repo.refs.get(`refs/heads/${targetBranch}`) ?? null;
    if (tip === null && targetBranch !== repo.defaultBranch) {
      // A named branch that does not exist starts at the default tip.
      tip = this.defaultTip(repo);
    }
    const files = tip === null ? new Map() : this.filesAtCommit(repo, tip);
    const existing = files.get(path);
    if (sha !== undefined && sha !== '') {
      if (existing === undefined || existing.oid !== sha) {
        return { status: 409, error: 'sha does not match the current file' };
      }
    }
    const blobOid = hashObject('blob', content);
    repo.objects.set(blobOid, { type: 'blob', data: content });
    const isUpdate = existing !== undefined;
    files.set(path, { mode: '100644', oid: blobOid });
    const commitSha = this.createFileCommit(repo, targetBranch, files, message, tip);
    return { status: isUpdate ? 200 : 201, contentSha: blobOid, commitSha };
  }

  /** Delete one file through the contents API; returns its removal commit. */
  deleteContents(
    repo: Repo,
    path: string,
    message: string,
    branch: string | undefined,
    sha: string | undefined,
  ): { commitSha: string } | { status: 409; error: string } | { status: 404; error: string } {
    const targetBranch = branch ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${targetBranch}`) ?? null;
    if (tip === null) return { status: 404, error: 'branch has no commits' };
    const files = this.filesAtCommit(repo, tip);
    const existing = files.get(path);
    if (existing === undefined) return { status: 404, error: 'file not found' };
    if (sha !== undefined && sha !== '' && existing.oid !== sha) {
      return { status: 409, error: 'sha does not match the current file' };
    }
    files.delete(path);
    const commitSha = this.createFileCommit(repo, targetBranch, files, message, tip);
    return { commitSha };
  }

  /** Read a path at a ref (branch name, ref, or commit id): file, dir, or missing. */
  readContents(repo: Repo, path: string, ref: string | undefined): ContentsEntry {
    const tip = ref === undefined ? this.defaultTip(repo) : this.resolveRef(repo, ref);
    if (tip === null) return { kind: 'missing' };
    const commit = repo.objects.get(this.peelToCommit(repo, tip));
    if (commit === undefined || commit.type !== 'commit') return { kind: 'missing' };
    const files = this.filesAtCommit(repo, this.peelToCommit(repo, tip));
    if (path === '' || path === '/') {
      return { kind: 'dir', entries: this.directoryEntries(repo, files, '') };
    }
    const file = files.get(path);
    if (file !== undefined) {
      const blob = repo.objects.get(file.oid);
      if (blob === undefined) return { kind: 'missing' };
      const name = path.split('/').pop() as string;
      return { kind: 'file', name, path, sha: file.oid, size: blob.data.length, data: blob.data };
    }
    // A directory: any file below this path.
    const prefix = `${path}/`;
    let isDir = false;
    for (const key of files.keys()) {
      if (key.startsWith(prefix)) {
        isDir = true;
        break;
      }
    }
    if (!isDir) return { kind: 'missing' };
    return { kind: 'dir', entries: this.directoryEntries(repo, files, path) };
  }

  private directoryEntries(
    repo: Repo,
    files: Map<string, { mode: string; oid: string }>,
    dir: string,
  ): Array<{ name: string; path: string; sha: string; type: 'file' | 'dir'; size: number }> {
    const prefix = dir === '' ? '' : `${dir}/`;
    const children = new Map<string, { name: string; path: string; sha: string; type: 'file' | 'dir'; size: number }>();
    for (const [path, entry] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        const blob = repo.objects.get(entry.oid);
        children.set(rest, { name: rest, path, sha: entry.oid, type: 'file', size: blob?.data.length ?? 0 });
      } else {
        const name = rest.slice(0, slash);
        if (!children.has(name)) {
          // The directory's sha is its tree id; find it by walking the tree.
          children.set(name, { name, path: `${prefix}${name}`, sha: this.treeOidForDir(repo, files, `${prefix}${name}`), type: 'dir', size: 0 });
        }
      }
    }
    return [...children.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The tree id of a directory path, rebuilt from the flat file map. */
  private treeOidForDir(
    repo: Repo,
    files: Map<string, { mode: string; oid: string }>,
    dir: string,
  ): string {
    const prefix = `${dir}/`;
    const sub = new Map<string, { mode: string; oid: string }>();
    for (const [path, entry] of files) {
      if (path.startsWith(prefix)) sub.set(path.slice(prefix.length), entry);
    }
    // Build the trees without storing them twice: reuse buildNestedTrees on
    // a scratch map, then return its root (it is identical to the stored one).
    const scratch = new Map<string, GitObject>();
    const root = buildNestedTrees(scratch, sub);
    void repo;
    return root;
  }

  // ------------------------------------------------------------ labels and issues

  createLabel(repo: Repo, name: string, color?: string): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: Label = { name, color: color ?? DEFAULT_LABEL_COLOR };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(
    repo: Repo,
    input: { title: string; body?: string; labels?: readonly string[] },
  ): { issue: Issue } | { error: string } {
    const labels: Label[] = [];
    for (const name of input.labels ?? []) {
      const label = repo.labels.get(name);
      if (label === undefined) return { error: `Label "${name}" does not exist` };
      labels.push(label);
    }
    const now = this.clock.nowIso;
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.numberCounter,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels,
      createdAt: now,
      updatedAt: now,
      comments: [],
    };
    this.nextIssueId += 1;
    repo.numberCounter += 1;
    repo.issues.set(issue.number, issue);
    return { issue };
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  /** Issues ordered by creation (number); state filter and direction applied. */
  listIssues(
    repo: Repo,
    options: { state?: string; direction?: string } = {},
  ): Issue[] {
    const state = options.state ?? 'open';
    const direction = options.direction ?? 'desc';
    const all = [...repo.issues.values()].sort((a, b) => a.number - b.number);
    const filtered = state === 'all' ? all : all.filter((issue) => issue.state === state);
    if (direction === 'asc') return filtered;
    return filtered.reverse();
  }

  patchIssue(repo: Repo, number: number, patch: { state?: string; title?: string; body?: string }): Issue | undefined {
    const issue = repo.issues.get(number);
    if (issue === undefined) return undefined;
    if (patch.state === 'closed' || patch.state === 'open') issue.state = patch.state;
    if (patch.title !== undefined) (issue as { title: string }).title = patch.title;
    if (patch.body !== undefined) (issue as { body: string }).body = patch.body;
    issue.updatedAt = this.clock.nowIso;
    return issue;
  }

  createComment(repo: Repo, issueNumber: number, body: string): IssueComment | undefined {
    const issue = repo.issues.get(issueNumber);
    if (issue === undefined) return undefined;
    const comment: IssueComment = { id: this.nextCommentId, body, createdAt: this.clock.nowIso };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // ------------------------------------------------------------ pull requests

  createPull(
    repo: Repo,
    input: { title: string; body?: string; head: string; base: string },
  ): { pull: PullRequest } | { error: string; status: 422 } {
    const headSha = repo.refs.get(`refs/heads/${input.head}`);
    const baseSha = repo.refs.get(`refs/heads/${input.base}`);
    if (headSha === undefined || baseSha === undefined) {
      return { error: 'head or base branch does not exist', status: 422 };
    }
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
        return { error: 'a pull request is already open for this head and base', status: 422 };
      }
    }
    const now = this.clock.nowIso;
    const pull: PullRequest = {
      id: this.nextIssueId,
      number: repo.numberCounter,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.head,
      baseRef: input.base,
      headSha,
      baseSha,
      createdAt: now,
      updatedAt: now,
    };
    this.nextIssueId += 1;
    repo.numberCounter += 1;
    repo.pulls.set(pull.number, pull);
    return { pull };
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.get(number);
  }

  listPulls(repo: Repo, state?: string): PullRequest[] {
    const all = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
    if (state === undefined || state === 'open') return all.filter((pull) => pull.state === 'open');
    if (state === 'all') return all;
    if (state === 'closed') return all.filter((pull) => pull.state === 'closed');
    return all.filter((pull) => pull.state === 'open');
  }

  /** The files a pull request changes: merge-base tree versus head tree. */
  pullFiles(repo: Repo, pull: PullRequest): PullFile[] {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const base = this.mergeBase(repo, headTip, pull.baseSha) ?? pull.baseSha;
    const baseFiles = base === pull.baseSha && base === headTip ? new Map() : this.filesAtCommit(repo, base);
    const headFiles = this.filesAtCommit(repo, headTip);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: PullFile[] = [];
    for (const path of [...paths].sort()) {
      const oldEntry = baseFiles.get(path);
      const newEntry = headFiles.get(path);
      if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
      if (oldEntry === undefined && newEntry !== undefined) {
        const blob = repo.objects.get(newEntry.oid);
        const text = blob?.data.toString('utf8') ?? '';
        const additions = text === '' ? 0 : text.split('\n').length;
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (oldEntry !== undefined && newEntry === undefined) {
        const blob = repo.objects.get(oldEntry.oid);
        const text = blob?.data.toString('utf8') ?? '';
        const deletions = text === '' ? 0 : text.split('\n').length;
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (oldEntry !== undefined && newEntry !== undefined) {
        const oldText = repo.objects.get(oldEntry.oid)?.data.toString('utf8') ?? '';
        const newText = repo.objects.get(newEntry.oid)?.data.toString('utf8') ?? '';
        const { additions, deletions } = lineDiff(oldText, newText);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /**
   * Three-way merge of base, head and current-base trees. Returns the merged
   * file map, or null when a path changed differently on both sides.
   */
  threeWayMerge(
    base: Map<string, { mode: string; oid: string }>,
    head: Map<string, { mode: string; oid: string }>,
    current: Map<string, { mode: string; oid: string }>,
  ): Map<string, { mode: string; oid: string }> | null {
    const merged = new Map(current);
    const paths = new Set([...base.keys(), ...head.keys(), ...current.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      const c = current.get(path);
      const same = (a?: { oid: string }, d?: { oid: string }): boolean =>
        (a === undefined && d === undefined) || (a !== undefined && d !== undefined && a.oid === d.oid);
      if (same(h, b)) continue; // head unchanged: keep the current side
      if (same(c, b)) {
        // Current side unchanged: take the head side (or its deletion).
        if (h === undefined) merged.delete(path);
        else merged.set(path, h);
        continue;
      }
      if (same(h, c)) continue; // both changed to the same thing
      return null; // both changed differently: conflict
    }
    return merged;
  }

  /** Whether a pull request's head merges cleanly onto its base right now. */
  pullMergeable(repo: Repo, pull: PullRequest): boolean {
    if (pull.state !== 'open') return false;
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = this.mergeBase(repo, headTip, baseTip);
    if (base === null) return false;
    const merged = this.threeWayMerge(
      this.filesAtCommit(repo, base),
      this.filesAtCommit(repo, headTip),
      this.filesAtCommit(repo, baseTip),
    );
    return merged !== null;
  }

  /**
   * Squash-merge a pull request: one commit on the base branch whose tree
   * holds the head's changes, parents [base tip]. Returns the merge commit
   * id, or an error status (404 unknown, 405 conflicted or already merged).
   */
  mergePull(
    repo: Repo,
    number: number,
  ): { sha: string; message: string } | { error: string; status: 404 | 405 } {
    const pull = repo.pulls.get(number);
    if (pull === undefined) return { error: 'pull request not found', status: 404 };
    if (pull.state !== 'open') return { error: 'pull request is already closed', status: 405 };
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = this.mergeBase(repo, headTip, baseTip);
    if (base === null) return { error: 'no merge base', status: 405 };
    const merged = this.threeWayMerge(
      this.filesAtCommit(repo, base),
      this.filesAtCommit(repo, headTip),
      this.filesAtCommit(repo, baseTip),
    );
    if (merged === null) return { error: 'merge conflict', status: 405 };
    const identity = this.viewerIdentity();
    const line = identityLine(identity.name, identity.email, this.clock.nowSec);
    const treeOid = buildNestedTrees(repo.objects, merged);
    const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
    const commit = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      author: line,
      committer: line,
      message,
    });
    const commitOid = hashObject('commit', commit);
    repo.objects.set(commitOid, { type: 'commit', data: commit });
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.clock.nowIso;
    pull.mergeCommitSha = commitOid;
    pull.updatedAt = this.clock.nowIso;
    return { sha: commitOid, message };
  }

  // ------------------------------------------------------------ fetch planning

  /**
   * Plan a fetch: which objects to send for `wants`, excluding everything
   * the client already holds (`haves` plus its current shallow boundaries),
   * with an optional depth limit. Returns the objects in send order plus the
   * shallow-info lines (new boundaries and newly unshallowed commits).
   */
  planFetch(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    clientShallow: readonly string[],
    depth: number | null,
    deepenSince: number | null,
    deepenNot: readonly string[],
  ): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
    // Everything the client already holds: the ancestors of the haves and
    // deepen-not tips, but never below one of the client's shallow
    // boundaries — a shallow clone holds the boundary commit and its tree,
    // not the history beneath it.
    const held = new Set<string>();
    const heldObjects = new Set<string>();
    const boundarySet = new Set(clientShallow.map((b) => this.peelToCommit(repo, b)));
    const visitHeld = (tip: string): void => {
      const stack = [this.peelToCommit(repo, tip)];
      const seenHeld = new Set<string>();
      while (stack.length > 0) {
        const oid = stack.pop() as string;
        if (seenHeld.has(oid)) continue;
        seenHeld.add(oid);
        held.add(oid);
        const object = repo.objects.get(oid);
        if (object === undefined || object.type !== 'commit') continue;
        const parsed = parseCommit(object.data);
        heldObjects.add(oid);
        this.addTreeObjectsToSet(repo, parsed.tree, heldObjects);
        if (boundarySet.has(oid)) continue; // history stops at the boundary
        for (const parent of parsed.parents) stack.push(parent);
      }
    };
    for (const tip of [...haves, ...deepenNot]) visitHeld(tip);
    for (const boundary of clientShallow) {
      held.add(this.peelToCommit(repo, boundary));
    }
    // Walk from the wants with the depth limit, excluding held commits.
    // A commit is included only when it is not held, is within the depth,
    // and (for deepen-since) is not older than the cutoff.
    const included = new Set<string>();
    interface WalkItem {
      oid: string;
      depth: number;
    }
    const queue: WalkItem[] = [];
    for (const want of wants) {
      const peeled = this.peelToCommit(repo, want);
      queue.push({ oid: peeled, depth: 1 });
      // An annotated tag want is itself an object to send.
      if (want !== peeled) included.add(want);
    }
    const seen = new Set<string>();
    while (queue.length > 0) {
      const item = queue.shift() as WalkItem;
      if (seen.has(item.oid)) continue;
      seen.add(item.oid);
      const object = repo.objects.get(item.oid);
      if (object === undefined) continue;
      if (object.type === 'tag') {
        if (!held.has(item.oid)) included.add(item.oid);
        queue.push({ oid: this.peelToCommit(repo, item.oid), depth: item.depth });
        continue;
      }
      if (object.type !== 'commit') {
        if (!held.has(item.oid)) included.add(item.oid);
        continue;
      }
      const parsed = parseCommit(object.data);
      if (deepenSince !== null) {
        const stamp = parsed.timestamp;
        if (stamp !== null && stamp < deepenSince) continue;
      }
      // A held commit is not sent, but its parents may still be needed: a
      // deepen fetch reaches past a held shallow boundary to its parents.
      // Without a depth limit a shallow boundary is a root and stops the walk,
      // so a plain fetch from a shallow clone sends nothing new.
      if (!held.has(item.oid)) included.add(item.oid);
      if (depth !== null && item.depth >= depth) continue; // parents cut off
      if (held.has(item.oid) && boundarySet.has(item.oid) && depth === null) continue;
      for (const parent of parsed.parents) queue.push({ oid: parent, depth: item.depth + 1 });
    }
    // A commit is a new shallow boundary when it is included, has parents,
    // and none of its parents is included or held: its history stops here.
    const shallow: string[] = [];
    for (const oid of included) {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0) continue;
      if (parents.every((parent) => included.has(parent) || held.has(parent))) continue;
      shallow.push(oid);
    }
    // A client shallow boundary is unshallowed when its parents are now
    // included (or held): its history is complete after this fetch.
    const unshallow: string[] = [];
    for (const boundary of clientShallow) {
      const peeled = this.peelToCommit(repo, boundary);
      const object = repo.objects.get(peeled);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.every((parent) => included.has(parent) || held.has(parent))) {
        unshallow.push(peeled);
      }
    }
    // Collect the objects: each included commit's own tree and blobs only
    // (never an ancestor's), minus anything the client already holds.
    const send = new Map<string, GitObject>();
    const ordered: GitObject[] = [];
    const addObject = (oid: string): void => {
      if (heldObjects.has(oid) || send.has(oid)) return;
      const object = repo.objects.get(oid);
      if (object === undefined) return;
      send.set(oid, object);
      ordered.push(object);
    };
    for (const oid of included) {
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      addObject(oid);
      if (object.type === 'commit') {
        const tree = parseCommit(object.data).tree;
        this.addTreeObjects(repo, tree, addObject);
      }
    }
    return { objects: ordered, shallow, unshallow };
  }

  private addTreeObjects(
    repo: Repo,
    treeOid: string,
    add: (oid: string) => void,
  ): void {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    add(treeOid);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') this.addTreeObjects(repo, entry.oid, add);
      else add(entry.oid);
    }
  }

  /** The same walk as addTreeObjects, collecting ids into a set. */
  private addTreeObjectsToSet(
    repo: Repo,
    treeOid: string,
    out: Set<string>,
  ): void {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    if (out.has(treeOid)) return;
    out.add(treeOid);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') this.addTreeObjectsToSet(repo, entry.oid, out);
      else out.add(entry.oid);
    }
  }

  // ------------------------------------------------------------ receive-pack

  /**
   * Apply one push command after its pack's objects are stored. Returns
   * 'ok' or the refusal reason ('non-fast-forward' for a rejected update).
   * Create requires the ref absent; delete removes it; update requires the
   * old id to match the current tip and the new id to descend from it.
   */
  applyPushCommand(
    repo: Repo,
    command: { oldOid: string; newOid: string; ref: string },
  ): { ok: true } | { ok: false; reason: string } {
    const current = repo.refs.get(command.ref) ?? null;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === null) return { ok: false, reason: 'remote ref does not exist' };
      if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        return { ok: false, reason: 'non-fast-forward' };
      }
      repo.refs.delete(command.ref);
      return { ok: true };
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== null) return { ok: false, reason: 'remote ref already exists' };
      if (!repo.objects.has(command.newOid)) return { ok: false, reason: 'object not found' };
      repo.refs.set(command.ref, command.newOid);
      return { ok: true };
    }
    // Update.
    if (current === null) return { ok: false, reason: 'remote ref does not exist' };
    if (command.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
    if (!repo.objects.has(command.newOid)) return { ok: false, reason: 'object not found' };
    if (!this.isAncestor(repo, current, command.newOid)) {
      return { ok: false, reason: 'non-fast-forward' };
    }
    repo.refs.set(command.ref, command.newOid);
    return { ok: true };
  }
}

/** All refs sorted by name: [name, oid] pairs. */
export function sortedRefs(repo: Repo): Array<[string, string]> {
  const refs = [...repo.refs.entries()];
  refs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return refs;
}

/** Peel an annotated tag to its target commit, following tag objects. */
export function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let hops = 0; hops < 10; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}
