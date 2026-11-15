// GraphQL v4 at /api/graphql: a small parser and executor for exactly the
// documents real clients send (gh's repository, issue and pull-request
// queries, its feature-detection introspection probes, and its mutations),
// over the same store as REST.
//
// Rules the suite checks: unauthenticated requests are exactly 401 (the
// server enforces that before this handler); an unknown field is HTTP 200
// with an `errors` array naming it, and the valid fields still answer; an
// unknown repository is `data.repository = null` with no errors; two
// operations in one body answer in order; global ids are opaque (base64 of
// a tagged string) and stable across reads.

import type { Reply } from './respond.ts';
import type { ForgeStore, Issue, PullRequest, Repo } from './store.ts';

// ------------------------------------------------------------------ tokenizer

type TokenKind =
  | 'braceL'
  | 'braceR'
  | 'parenL'
  | 'parenR'
  | 'bracketL'
  | 'bracketR'
  | 'colon'
  | 'bang'
  | 'dollar'
  | 'equals'
  | 'spread'
  | 'name'
  | 'string'
  | 'int'
  | 'float';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === ';') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '{') {
      tokens.push({ kind: 'braceL', value: ch });
      i += 1;
      continue;
    }
    if (ch === '}') {
      tokens.push({ kind: 'braceR', value: ch });
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'parenL', value: ch });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'parenR', value: ch });
      i += 1;
      continue;
    }
    if (ch === '[') {
      tokens.push({ kind: 'bracketL', value: ch });
      i += 1;
      continue;
    }
    if (ch === ']') {
      tokens.push({ kind: 'bracketR', value: ch });
      i += 1;
      continue;
    }
    if (ch === ':') {
      tokens.push({ kind: 'colon', value: ch });
      i += 1;
      continue;
    }
    if (ch === '!') {
      tokens.push({ kind: 'bang', value: ch });
      i += 1;
      continue;
    }
    if (ch === '$') {
      tokens.push({ kind: 'dollar', value: ch });
      i += 1;
      continue;
    }
    if (ch === '=') {
      tokens.push({ kind: 'equals', value: ch });
      i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const next = source[j + 1] as string;
          if (next === 'n') out += '\n';
          else if (next === 't') out += '\t';
          else if (next === 'r') out += '\r';
          else if (next === '"') out += '"';
          else if (next === '\\') out += '\\';
          else if (next === '/') out += '/';
          else if (next === 'u' && j + 5 < source.length) {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += next;
          j += 2;
          continue;
        }
        out += source[j];
        j += 1;
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ------------------------------------------------------------------ parser

type ValueNode =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'list'; readonly values: ValueNode[] }
  | { readonly kind: 'object'; readonly fields: Array<{ name: string; value: ValueNode }> };

interface Selection {
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ name: string; value: ValueNode }>;
  readonly selections: Selection[] | null;
  /** Inline fragment: `... on Type { ... }` — name is '' and this is set. */
  readonly typeCondition: string | null;
}

interface Operation {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  readonly selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expect(kind: TokenKind, what: string): Token {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`expected ${what}, got ${token.kind} ${JSON.stringify(token.value)}`);
    return token;
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected ${what}, got ${token.kind}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      this.next();
      kind = token.value as 'query' | 'mutation';
      const next = this.peek();
      if (next?.kind === 'name') name = this.next().value;
    } else if (token?.kind === 'braceL') {
      kind = 'query';
    } else {
      throw new Error(`expected an operation, got ${token?.kind ?? 'end of document'}`);
    }
    const variableDefinitions = this.parseVariableDefinitions();
    const selections = this.parseSelectionSet();
    return { kind, name, variableDefinitions, selections };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek()?.kind !== 'parenL') return defs;
    this.next();
    while (this.peek()?.kind !== 'parenR') {
      this.expect('dollar', '$');
      const name = this.expectName('a variable name');
      this.expect('colon', ':');
      // The type: a name, possibly wrapped in [ ] and suffixed with !.
      this.parseTypeReference();
      let defaultValue: ValueNode | null = null;
      if (this.peek()?.kind === 'equals') {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, defaultValue });
    }
    this.expect('parenR', ')');
    return defs;
  }

  private parseTypeReference(): void {
    const token = this.peek();
    if (token?.kind === 'bracketL') {
      this.next();
      this.parseTypeReference();
      this.expect('bracketR', ']');
    } else {
      this.expectName('a type name');
    }
    if (this.peek()?.kind === 'bang') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expect('braceL', '{');
    const selections: Selection[] = [];
    while (this.peek()?.kind !== 'braceR') {
      selections.push(this.parseSelection());
    }
    this.expect('braceR', '}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      // Inline fragment `... on Type { ... }` or a named fragment spread
      // (the suite sends only inline fragments; a named one is an error).
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type name');
        const selections = this.parseSelectionSet();
        return { alias: null, name: '', args: [], selections, typeCondition };
      }
      throw new Error('named fragment spreads are not supported');
    }
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === 'colon') {
      this.next();
      alias = first;
      name = this.expectName('a field name');
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.kind === 'parenL') {
      this.next();
      while (this.peek()?.kind !== 'parenR') {
        const argName = this.expectName('an argument name');
        this.expect('colon', ':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect('parenR', ')');
    }
    let selections: Selection[] | null = null;
    if (this.peek()?.kind === 'braceL') selections = this.parseSelectionSet();
    return { alias, name, args, selections, typeCondition: null };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: Number(token.value) };
      case 'float':
        return { kind: 'float', value: Number(token.value) };
      case 'dollar': {
        const name = this.expectName('a variable name');
        return { kind: 'variable', name };
      }
      case 'bracketL': {
        const values: ValueNode[] = [];
        while (this.peek()?.kind !== 'bracketR') values.push(this.parseValue());
        this.expect('bracketR', ']');
        return { kind: 'list', values };
      }
      case 'braceL': {
        const fields: Array<{ name: string; value: ValueNode }> = [];
        while (this.peek()?.kind !== 'braceR') {
          const name = this.expectName('an input field name');
          this.expect('colon', ':');
          fields.push({ name, value: this.parseValue() });
        }
        this.expect('braceR', '}');
        return { kind: 'object', fields };
      }
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      default:
        throw new Error(`unexpected token ${token.kind} as a value`);
    }
  }
}

// ------------------------------------------------------------------ values

type Variables = Record<string, unknown>;

/** Resolve a parsed value against the operation's variables. */
function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'variable':
      return variables[node.name] ?? null;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

/** Resolve a selection's arguments, dropping null-valued ones. */
function resolveArgs(selection: Selection, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of selection.args) {
    const value = resolveValue(arg.value, variables);
    if (value !== null) out[arg.name] = value;
  }
  return out;
}

// ------------------------------------------------------------------ global ids

/** An opaque global id: base64 of `Tag:payload`. */
export function globalId(tag: string, payload: string): string {
  return Buffer.from(`${tag}:${payload}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { tag: string; payload: string } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = text.indexOf(':');
  if (colon <= 0) return null;
  return { tag: text.slice(0, colon), payload: text.slice(colon + 1) };
}

function repoGlobalId(repo: Repo): string {
  const owner = repo.owner ?? '';
  return globalId('Repository', `${owner}/${repo.name}`);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  const owner = repo.owner ?? '';
  return globalId('Issue', `${owner}/${repo.name}#${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: PullRequest): string {
  const owner = repo.owner ?? '';
  return globalId('PullRequest', `${owner}/${repo.name}#${pull.number}`);
}

function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  const owner = repo.owner ?? '';
  return globalId('IssueComment', `${owner}/${repo.name}#${issueNumber}:${commentId}`);
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!text.startsWith('cursor:')) return null;
  const number = Number(text.slice('cursor:'.length));
  return Number.isSafeInteger(number) ? number : null;
}

// ------------------------------------------------------------------ schema

/** The fields each type exposes (introspection and validation read this). */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Viewer: ['login'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'state', 'headRefName', 'baseRefName', 'mergeable',
    'merged', 'files', 'body', 'headRef', 'baseRef', 'createdAt', 'updatedAt',
  ],
  User: ['login'],
  Ref: ['name'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  FileConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  IssueComment: ['id', 'body', 'author'],
  IssueCommentEdge: ['node'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changes', 'status'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

// ------------------------------------------------------------------ executor

interface ExecContext {
  readonly store: ForgeStore;
  readonly variables: Variables;
  readonly errors: Array<{ message: string }>;
}

type SourceValue =
  | { readonly __typename: 'Query' }
  | { readonly __typename: 'Mutation' }
  | { readonly __typename: 'Viewer'; readonly login: string }
  | { readonly __typename: 'Repository'; readonly repo: Repo }
  | { readonly __typename: 'Issue'; readonly repo: Repo; readonly issue: Issue }
  | { readonly __typename: 'PullRequest'; readonly repo: Repo; readonly pull: PullRequest }
  | { readonly __typename: 'User'; readonly login: string }
  | { readonly __typename: 'Ref'; readonly name: string }
  | { readonly __typename: 'IssueConnection'; readonly repo: Repo; readonly issues: Issue[]; readonly pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { readonly __typename: 'PullRequestConnection'; readonly pulls: PullRequest[]; readonly repo: Repo }
  | { readonly __typename: 'FileConnection'; readonly files: Array<{ path: string; additions: number; deletions: number; changes: number; status: string }> }
  | { readonly __typename: 'PageInfo'; readonly hasNextPage: boolean; readonly endCursor: string | null }
  | { readonly __typename: 'IssueComment'; readonly repo: Repo; readonly issueNumber: number; readonly comment: { id: number; body: string } }
  | { readonly __typename: 'IssueCommentEdge'; readonly node: SourceValue }
  | { readonly __typename: 'PullRequestFile'; readonly file: { path: string; additions: number; deletions: number; changes: number; status: string } }
  | { readonly __typename: 'CreateIssuePayload'; readonly issue: SourceValue | null }
  | { readonly __typename: 'CloseIssuePayload'; readonly issue: SourceValue | null }
  | { readonly __typename: 'CreatePullRequestPayload'; readonly pull: SourceValue | null }
  | { readonly __typename: 'MergePullRequestPayload'; readonly pull: SourceValue | null }
  | { readonly __typename: 'AddCommentPayload'; readonly commentEdge: SourceValue | null }
  | { readonly __typename: '__Type'; readonly name: string; readonly kind: string }
  | { readonly __typename: '__Field'; readonly name: string }
  | { readonly __typename: '__EnumValue'; readonly name: string };

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** Find a repository by owner+name, honouring the viewer binding. */
function findRepo(ctx: ExecContext, owner: string, name: string): Repo | null {
  if (!ctx.store.resolveOwner(owner)) return null;
  const repo = ctx.store.getRepo(name);
  if (repo === undefined || repo.owner !== owner) return null;
  return repo;
}

/** Find an issue or pull request by its global id. */
function findByGlobalId(
  ctx: ExecContext,
  id: string,
): { repo: Repo; issue?: Issue; pull?: PullRequest } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const hash = decoded.payload.indexOf('#');
  if (hash < 0) {
    // A repository id: `owner/name`.
    if (decoded.tag !== 'Repository') return null;
    const slash = decoded.payload.indexOf('/');
    if (slash < 0) return null;
    const repo = findRepo(ctx, decoded.payload.slice(0, slash), decoded.payload.slice(slash + 1));
    return repo === null ? null : { repo };
  }
  const ownerRepo = decoded.payload.slice(0, hash);
  const rest = decoded.payload.slice(hash + 1);
  const slash = ownerRepo.indexOf('/');
  if (slash < 0) return null;
  const repo = findRepo(ctx, ownerRepo.slice(0, slash), ownerRepo.slice(slash + 1));
  if (repo === null) return null;
  const number = Number(rest.split(':')[0]);
  if (!Number.isSafeInteger(number)) return null;
  if (decoded.tag === 'Issue') {
    const issue = repo.issues.get(number);
    return issue === undefined ? null : { repo, issue };
  }
  if (decoded.tag === 'PullRequest') {
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : { repo, pull };
  }
  return null;
}

/**
 * Execute one field against a source value. Returns the field's JSON value
 * (an object source is itself a SourceValue for nested selections).
 */
function resolveField(
  ctx: ExecContext,
  source: SourceValue,
  selection: Selection,
): unknown {
  const args = resolveArgs(selection, ctx.variables);
  const store = ctx.store;
  switch (source.__typename) {
    case 'Query': {
      if (selection.name === 'viewer') {
        if (store.viewerLogin === null) return null;
        return { __typename: 'Viewer', login: store.viewerLogin } as SourceValue;
      }
      if (selection.name === 'repository') {
        const owner = args.owner as string | undefined;
        const name = args.name as string | undefined;
        if (owner === undefined || name === undefined) return null;
        const repo = findRepo(ctx, owner, name);
        return repo === null ? null : ({ __typename: 'Repository', repo } as SourceValue);
      }
      if (selection.name === 'node') {
        const id = args.id as string | undefined;
        if (id === undefined) return null;
        const found = findByGlobalId(ctx, id);
        if (found === null) return null;
        if (found.issue !== undefined) {
          return { __typename: 'Issue', repo: found.repo, issue: found.issue } as SourceValue;
        }
        if (found.pull !== undefined) {
          return { __typename: 'PullRequest', repo: found.repo, pull: found.pull } as SourceValue;
        }
        return { __typename: 'Repository', repo: found.repo } as SourceValue;
      }
      if (selection.name === '__type') {
        const name = args.name as string | undefined;
        if (name === undefined) return null;
        if (TYPE_FIELDS[name] === undefined && name !== 'SearchType') return null;
        const kind = name === 'SearchType' ? 'ENUM' : 'OBJECT';
        return { __typename: '__Type', name, kind } as SourceValue;
      }
      return null;
    }
    case 'Mutation': {
      if (selection.name === 'createIssue') return mutateCreateIssue(ctx, args);
      if (selection.name === 'closeIssue') return mutateCloseIssue(ctx, args);
      if (selection.name === 'createPullRequest') return mutateCreatePullRequest(ctx, args);
      if (selection.name === 'mergePullRequest') return mutateMergePullRequest(ctx, args);
      if (selection.name === 'addComment') return mutateAddComment(ctx, args);
      return null;
    }
    case 'Viewer':
      if (selection.name === 'login') return source.login;
      return null;
    case 'User':
      if (selection.name === 'login') return source.login;
      return null;
    case 'Ref':
      if (selection.name === 'name') return source.name;
      return null;
    case 'Repository': {
      const repo = source.repo;
      switch (selection.name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.databaseId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner ?? ''}/${repo.name}`;
        case 'owner':
          return { __typename: 'User', login: repo.owner ?? '' } as SourceValue;
        case 'defaultBranchRef': {
          const tip = store.defaultTip(repo);
          if (tip === null) return null;
          return { __typename: 'Ref', name: repo.defaultBranch } as SourceValue;
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const number = args.number as number | undefined;
          if (number === undefined) return null;
          const issue = repo.issues.get(number);
          return issue === undefined ? null : ({ __typename: 'Issue', repo, issue } as SourceValue);
        }
        case 'issues': {
          const first = args.first as number | undefined;
          const after = args.after as string | undefined;
          const states = (args.states as string[] | undefined) ?? [];
          const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
          let issues = [...repo.issues.values()].sort((a, b) => b.number - a.number);
          if (states.length > 0) {
            const wanted = new Set(states.map((state) => state.toLowerCase()));
            issues = issues.filter((issue) => wanted.has(issue.state));
          }
          if (orderBy !== undefined && orderBy.direction === 'ASC') issues.reverse();
          if (after !== undefined) {
            const afterNumber = numberFromCursor(after);
            if (afterNumber !== null) issues = issues.filter((issue) => issue.number < afterNumber);
          }
          const total = issues.length;
          const page = first === undefined ? issues : issues.slice(0, first);
          const hasNextPage = page.length < total;
          const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number ?? 0) : null;
          return {
            __typename: 'IssueConnection',
            repo,
            issues: page,
            pageInfo: { hasNextPage, endCursor },
          } as SourceValue;
        }
        case 'pullRequests': {
          const first = args.first as number | undefined;
          let pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
          if (first !== undefined) pulls = pulls.slice(0, first);
          return { __typename: 'PullRequestConnection', pulls, repo } as SourceValue;
        }
        case 'pullRequest': {
          const number = args.number as number | undefined;
          if (number === undefined) return null;
          const pull = repo.pulls.get(number);
          return pull === undefined ? null : ({ __typename: 'PullRequest', repo, pull } as SourceValue);
        }
        default:
          return null;
      }
    }
    case 'Issue': {
      const issue = source.issue;
      switch (selection.name) {
        case 'id':
          return issueGlobalId(source.repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issueState(issue);
        case 'body':
          return issue.body;
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'author':
          return { __typename: 'User', login: source.repo.owner ?? '' } as SourceValue;
        case 'labels':
          return issue.labels.map((label) => label.name);
        case 'comments':
          return issue.comments.map((comment) => ({
            __typename: 'IssueComment',
            repo: source.repo,
            issueNumber: issue.number,
            comment,
          })) as SourceValue[];
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const pull = source.pull;
      switch (selection.name) {
        case 'id':
          return pullGlobalId(source.repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'state':
          return pullState(pull);
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          return store.pullMergeable(source.repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'merged':
          return pull.merged;
        case 'body':
          return pull.body;
        case 'headRef':
          return pull.headRef;
        case 'baseRef':
          return pull.baseRef;
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'files': {
          const first = args.first as number | undefined;
          let files = store.pullFiles(source.repo, pull);
          if (first !== undefined) files = files.slice(0, first);
          return {
            __typename: 'FileConnection',
            files: files.map((file) => ({
              path: file.filename,
              additions: file.additions,
              deletions: file.deletions,
              changes: file.changes,
              status: file.status,
            })),
          } as SourceValue;
        }
        default:
          return null;
      }
    }
    case 'IssueConnection': {
      if (selection.name === 'nodes') {
        return source.issues.map(
          (issue) => ({ __typename: 'Issue', repo: source.repo, issue }) as SourceValue,
        );
      }
      if (selection.name === 'pageInfo') {
        return { __typename: 'PageInfo', hasNextPage: source.pageInfo.hasNextPage, endCursor: source.pageInfo.endCursor } as SourceValue;
      }
      if (selection.name === 'totalCount') return source.issues.length;
      return null;
    }
    case 'PullRequestConnection': {
      if (selection.name === 'nodes') {
        return source.pulls.map(
          (pull) => ({ __typename: 'PullRequest', repo: source.repo, pull }) as SourceValue,
        );
      }
      if (selection.name === 'pageInfo') {
        return { __typename: 'PageInfo', hasNextPage: false, endCursor: null } as SourceValue;
      }
      if (selection.name === 'totalCount') return source.pulls.length;
      return null;
    }
    case 'FileConnection': {
      if (selection.name === 'nodes') {
        return source.files.map((file) => ({ __typename: 'PullRequestFile', file }) as SourceValue);
      }
      if (selection.name === 'pageInfo') {
        return { __typename: 'PageInfo', hasNextPage: false, endCursor: null } as SourceValue;
      }
      return null;
    }
    case 'PageInfo': {
      if (selection.name === 'hasNextPage') return source.hasNextPage;
      if (selection.name === 'endCursor') return source.endCursor;
      if (selection.name === 'hasPreviousPage') return false;
      if (selection.name === 'startCursor') return null;
      return null;
    }
    case 'PullRequestFile': {
      const file = source.file;
      switch (selection.name) {
        case 'path':
          return file.path;
        case 'additions':
          return file.additions;
        case 'deletions':
          return file.deletions;
        case 'changes':
          return file.changes;
        case 'status':
          return file.status;
        default:
          return null;
      }
    }
    case 'IssueComment': {
      if (selection.name === 'id') return commentGlobalId(source.repo, source.issueNumber, source.comment.id);
      if (selection.name === 'body') return source.comment.body;
      if (selection.name === 'author') return { __typename: 'User', login: source.repo.owner ?? '' } as SourceValue;
      return null;
    }
    case 'IssueCommentEdge': {
      if (selection.name === 'node') return source.node;
      return null;
    }
    case 'CreateIssuePayload': {
      if (selection.name === 'issue') return source.issue;
      return null;
    }
    case 'CloseIssuePayload': {
      if (selection.name === 'issue') return source.issue;
      return null;
    }
    case 'CreatePullRequestPayload': {
      if (selection.name === 'pullRequest') return source.pull;
      return null;
    }
    case 'MergePullRequestPayload': {
      if (selection.name === 'pullRequest') return source.pull;
      return null;
    }
    case 'AddCommentPayload': {
      if (selection.name === 'commentEdge') return source.commentEdge;
      return null;
    }
    case '__Type': {
      if (selection.name === 'name') return source.name;
      if (selection.name === 'kind') return source.kind;
      if (selection.name === 'description') return null;
      if (selection.name === 'fields') {
        const fields = TYPE_FIELDS[source.name] ?? [];
        return fields.map((name) => ({ __typename: '__Field', name }) as SourceValue);
      }
      if (selection.name === 'enumValues') {
        if (source.name !== 'SearchType') return null;
        return SEARCH_TYPE_VALUES.map((name) => ({ __typename: '__EnumValue', name }) as SourceValue);
      }
      return null;
    }
    case '__Field': {
      if (selection.name === 'name') return source.name;
      if (selection.name === 'description') return null;
      return null;
    }
    case '__EnumValue': {
      if (selection.name === 'name') return source.name;
      if (selection.name === 'description') return null;
      return null;
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------ mutations

function inputObject(args: Record<string, unknown>, name: string): Record<string, unknown> | null {
  const value = args[name];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function mutateCreateIssue(ctx: ExecContext, args: Record<string, unknown>): SourceValue {
  const input = inputObject(args, 'input');
  if (input === null) {
    ctx.errors.push({ message: 'createIssue needs an input object' });
    return { __typename: 'CreateIssuePayload', issue: null };
  }
  const repositoryId = input.repositoryId as string | undefined;
  const title = input.title as string | undefined;
  if (repositoryId === undefined || title === undefined) {
    ctx.errors.push({ message: 'createIssue needs repositoryId and title' });
    return { __typename: 'CreateIssuePayload', issue: null };
  }
  const found = findByGlobalId(ctx, repositoryId);
  if (found === null) {
    ctx.errors.push({ message: 'repository not found' });
    return { __typename: 'CreateIssuePayload', issue: null };
  }
  const result = ctx.store.createIssue(found.repo, { title, body: (input.body as string | undefined) ?? '' });
  if ('error' in result) {
    ctx.errors.push({ message: result.error });
    return { __typename: 'CreateIssuePayload', issue: null };
  }
  return {
    __typename: 'CreateIssuePayload',
    issue: { __typename: 'Issue', repo: found.repo, issue: result.issue } as SourceValue,
  };
}

function mutateCloseIssue(ctx: ExecContext, args: Record<string, unknown>): SourceValue {
  const input = inputObject(args, 'input');
  if (input === null) {
    ctx.errors.push({ message: 'closeIssue needs an input object' });
    return { __typename: 'CloseIssuePayload', issue: null };
  }
  const issueId = input.issueId as string | undefined;
  if (issueId === undefined) {
    ctx.errors.push({ message: 'closeIssue needs issueId' });
    return { __typename: 'CloseIssuePayload', issue: null };
  }
  const found = findByGlobalId(ctx, issueId);
  if (found === null || found.issue === undefined) {
    ctx.errors.push({ message: 'issue not found' });
    return { __typename: 'CloseIssuePayload', issue: null };
  }
  const issue = ctx.store.patchIssue(found.repo, found.issue.number, { state: 'closed' });
  if (issue === undefined) {
    ctx.errors.push({ message: 'issue not found' });
    return { __typename: 'CloseIssuePayload', issue: null };
  }
  return {
    __typename: 'CloseIssuePayload',
    issue: { __typename: 'Issue', repo: found.repo, issue } as SourceValue,
  };
}

function mutateCreatePullRequest(ctx: ExecContext, args: Record<string, unknown>): SourceValue {
  const input = inputObject(args, 'input');
  if (input === null) {
    ctx.errors.push({ message: 'createPullRequest needs an input object' });
    return { __typename: 'CreatePullRequestPayload', pull: null };
  }
  const repositoryId = input.repositoryId as string | undefined;
  const baseRefName = input.baseRefName as string | undefined;
  const headRefName = input.headRefName as string | undefined;
  const title = input.title as string | undefined;
  if (repositoryId === undefined || baseRefName === undefined || headRefName === undefined || title === undefined) {
    ctx.errors.push({ message: 'createPullRequest needs repositoryId, baseRefName, headRefName and title' });
    return { __typename: 'CreatePullRequestPayload', pull: null };
  }
  const found = findByGlobalId(ctx, repositoryId);
  if (found === null) {
    ctx.errors.push({ message: 'repository not found' });
    return { __typename: 'CreatePullRequestPayload', pull: null };
  }
  const result = ctx.store.createPull(found.repo, {
    title,
    body: (input.body as string | undefined) ?? '',
    head: headRefName,
    base: baseRefName,
  });
  if ('error' in result) {
    ctx.errors.push({ message: result.error });
    return { __typename: 'CreatePullRequestPayload', pull: null };
  }
  return {
    __typename: 'CreatePullRequestPayload',
    pull: { __typename: 'PullRequest', repo: found.repo, pull: result.pull } as SourceValue,
  };
}

function mutateMergePullRequest(ctx: ExecContext, args: Record<string, unknown>): SourceValue {
  const input = inputObject(args, 'input');
  if (input === null) {
    ctx.errors.push({ message: 'mergePullRequest needs an input object' });
    return { __typename: 'MergePullRequestPayload', pull: null };
  }
  const pullRequestId = input.pullRequestId as string | undefined;
  if (pullRequestId === undefined) {
    ctx.errors.push({ message: 'mergePullRequest needs pullRequestId' });
    return { __typename: 'MergePullRequestPayload', pull: null };
  }
  const found = findByGlobalId(ctx, pullRequestId);
  if (found === null || found.pull === undefined) {
    ctx.errors.push({ message: 'pull request not found' });
    return { __typename: 'MergePullRequestPayload', pull: null };
  }
  const result = ctx.store.mergePull(found.repo, found.pull.number);
  if ('error' in result) {
    ctx.errors.push({ message: result.error });
    return { __typename: 'MergePullRequestPayload', pull: null };
  }
  const pull = found.repo.pulls.get(found.pull.number);
  if (pull === undefined) {
    ctx.errors.push({ message: 'pull request not found' });
    return { __typename: 'MergePullRequestPayload', pull: null };
  }
  return {
    __typename: 'MergePullRequestPayload',
    pull: { __typename: 'PullRequest', repo: found.repo, pull } as SourceValue,
  };
}

function mutateAddComment(ctx: ExecContext, args: Record<string, unknown>): SourceValue {
  const input = inputObject(args, 'input');
  if (input === null) {
    ctx.errors.push({ message: 'addComment needs an input object' });
    return { __typename: 'AddCommentPayload', commentEdge: null };
  }
  const subjectId = input.subjectId as string | undefined;
  const body = input.body as string | undefined;
  if (subjectId === undefined || body === undefined) {
    ctx.errors.push({ message: 'addComment needs subjectId and body' });
    return { __typename: 'AddCommentPayload', commentEdge: null };
  }
  const found = findByGlobalId(ctx, subjectId);
  if (found === null || found.issue === undefined) {
    ctx.errors.push({ message: 'comment subject not found' });
    return { __typename: 'AddCommentPayload', commentEdge: null };
  }
  const comment = ctx.store.createComment(found.repo, found.issue.number, body);
  if (comment === undefined) {
    ctx.errors.push({ message: 'issue not found' });
    return { __typename: 'AddCommentPayload', commentEdge: null };
  }
  const node: SourceValue = {
    __typename: 'IssueComment',
    repo: found.repo,
    issueNumber: found.issue.number,
    comment,
  };
  return {
    __typename: 'AddCommentPayload',
    commentEdge: { __typename: 'IssueCommentEdge', node } as SourceValue,
  };
}

// ------------------------------------------------------------------ selection walk

function isSourceValue(value: unknown): value is SourceValue {
  return typeof value === 'object' && value !== null && '__typename' in (value as Record<string, unknown>);
}

/**
 * Execute a selection set against a source value, returning the JSON object
 * for it. Unknown fields add an error naming the field and answer null for
 * that field; valid siblings still answer.
 */
function executeSelections(
  ctx: ExecContext,
  source: SourceValue,
  selections: Selection[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeName = source.__typename;
  const knownFields = TYPE_FIELDS[typeName] ?? [];
  for (const selection of selections) {
    if (selection.typeCondition !== null) {
      // Inline fragment: apply only when the type matches.
      if (selection.typeCondition !== typeName) continue;
      const nested = executeSelections(ctx, source, selection.selections ?? []);
      Object.assign(out, nested);
      continue;
    }
    const responseName = selection.alias ?? selection.name;
    if (!knownFields.includes(selection.name)) {
      ctx.errors.push({
        message: `Cannot query field "${selection.name}" on type "${typeName}".`,
      });
      out[responseName] = null;
      continue;
    }
    const value = resolveField(ctx, source, selection);
    out[responseName] = projectValue(ctx, value, selection.selections);
  }
  return out;
}

/** Project a resolved value through its sub-selections (if any). */
function projectValue(ctx: ExecContext, value: unknown, selections: Selection[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => projectValue(ctx, entry, selections));
  }
  if (isSourceValue(value)) {
    if (selections === null || selections.length === 0) return null;
    return executeSelections(ctx, value, selections);
  }
  return value;
}

/** Execute one operation (query or mutation) against the store. */
function executeOperation(
  store: ForgeStore,
  operation: Operation,
  variables: Variables,
): { data: Record<string, unknown>; errors: Array<{ message: string }> } {
  const ctx: ExecContext = { store, variables, errors: [] };
  const root: SourceValue =
    operation.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = executeSelections(ctx, root, operation.selections);
  return { data, errors: ctx.errors };
}

/** The handler: POST /api/graphql with {query, variables} or a batch array. */
export function handleGraphQL(store: ForgeStore, body: unknown, reply: Reply): void {
  const runOne = (operation: unknown): Record<string, unknown> => {
    if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
      return { errors: [{ message: 'each operation needs a query document' }] };
    }
    const record = operation as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string' || query.trim() === '') {
      return { errors: [{ message: 'a query document is required' }] };
    }
    const variables =
      typeof record.variables === 'object' && record.variables !== null && !Array.isArray(record.variables)
        ? (record.variables as Variables)
        : {};
    let operations: Operation[];
    try {
      operations = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'could not parse the query document' }] };
    }
    if (operations.length === 0) {
      return { errors: [{ message: 'the document holds no operation' }] };
    }
    let chosen = operations[0] as Operation;
    const operationName = record.operationName;
    if (typeof operationName === 'string' && operations.length > 1) {
      const named = operations.find((candidate) => candidate.name === operationName);
      if (named !== undefined) chosen = named;
    }
    const result = executeOperation(store, chosen, variables);
    const out: Record<string, unknown> = { data: result.data };
    if (result.errors.length > 0) out.errors = result.errors;
    return out;
  };
  if (Array.isArray(body)) {
    reply.json(200, body.map((operation) => runOne(operation)));
    return;
  }
  reply.json(200, runOne(body));
}
