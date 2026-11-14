import type { HttpClient } from '../src/http/http-client';
import type {
  CommitData,
  FileDiffData,
  IssueCommentData,
  IssueData,
  PullRequestCommentData,
  PullRequestData,
  QueryParams,
} from '../src/types';

export interface FakeCall {
  method: string;
  url: string;
  params: QueryParams;
  body?: unknown;
  getAllOptions?: unknown;
}

export interface FakeState {
  issues: IssueData[];
  issueComments: IssueCommentData[];
  pulls: PullRequestData[];
  prComments: Map<number, PullRequestCommentData[]>;
  prCommits: Map<number, CommitData[]>;
  files: FileDiffData[];
  respectSince: boolean;
}

/**
 * 轻量假 HttpClient，用于模型/轮询器测试。
 * 只实现测试需要的 GET 路由，写请求返回 responses 中配置的数据。
 */
export class FakeHttpClient {
  readonly calls: FakeCall[] = [];
  readonly state: FakeState = {
    issues: [],
    issueComments: [],
    pulls: [],
    prComments: new Map(),
    prCommits: new Map(),
    files: [],
    respectSince: true,
  };
  responses: Record<string, unknown> = {};

  constructor(state: Partial<FakeState> = {}) {
    Object.assign(this.state, state);
  }

  async get<T>(url: string, params: QueryParams = {}): Promise<T> {
    this.calls.push({ method: 'GET', url, params });
    const path = url.split('?')[0];

    if (path.endsWith('/issues/comments')) {
      return this.filterByCreatedAt(this.state.issueComments, params.since) as T;
    }

    const issueCommentsMatch = /\/issues\/([^/]+)\/comments$/.exec(path);
    if (issueCommentsMatch) {
      return this.filterByCreatedAt(this.state.issueComments, params.since) as T;
    }

    if (path.endsWith('/issues')) {
      let issues = [...this.state.issues];
      if (params.state === 'open') issues = issues.filter(issue => issue.state === 'open');
      if (params.state === 'closed') {
        issues = issues.filter(issue => issue.state === 'closed');
      }
      const after = parseDate(params.created_after ?? params.since);
      if (after !== null && this.state.respectSince) {
        issues = issues.filter(issue => (parseDate(issue.created_at) ?? 0) > after);
      }
      return issues as T;
    }

    const issueMatch = /\/issues\/([^/]+)$/.exec(path);
    if (issueMatch) {
      const number = decodeURIComponent(issueMatch[1]);
      const issue = this.state.issues.find(item => item.number === number);
      if (!issue) throw new Error(`Fake issue not found: ${number}`);
      return issue as T;
    }

    if (path.endsWith('/pulls')) {
      let pulls = [...this.state.pulls];
      if (params.state === 'open') pulls = pulls.filter(pr => pr.state === 'open');
      if (params.state === 'closed') pulls = pulls.filter(pr => pr.state === 'closed');
      const after = parseDate(params.since);
      if (after !== null && this.state.respectSince) {
        pulls = pulls.filter(pr => (parseDate(pr.updated_at) ?? 0) > after);
      }
      return pulls as T;
    }

    const prCommentsMatch = /\/pulls\/(\d+)\/comments$/.exec(path);
    if (prCommentsMatch) {
      return (this.state.prComments.get(Number(prCommentsMatch[1])) ?? []) as T;
    }

    const prCommitsMatch = /\/pulls\/(\d+)\/commits$/.exec(path);
    if (prCommitsMatch) {
      return (this.state.prCommits.get(Number(prCommitsMatch[1])) ?? []) as T;
    }

    const prFilesMatch = /\/pulls\/(\d+)\/files$/.exec(path);
    if (prFilesMatch) {
      return this.state.files as T;
    }

    const prMergeMatch = /\/pulls\/(\d+)\/merge$/.exec(path);
    if (prMergeMatch) {
      return (this.responses.merge ?? {}) as T;
    }

    const prMatch = /\/pulls\/(\d+)$/.exec(path);
    if (prMatch) {
      const number = Number(prMatch[1]);
      const pr = this.state.pulls.find(item => item.number === number);
      if (!pr) throw new Error(`Fake pull request not found: ${number}`);
      return pr as T;
    }

    throw new Error(`Unhandled fake GET ${path}`);
  }

  async getAll<T>(
    url: string,
    params: QueryParams = {},
    options: { perPage?: number; maxPages?: number; startPage?: number } = {}
  ): Promise<T[]> {
    this.calls.push({ method: 'GET_ALL', url, params, getAllOptions: options });
    return this.get<T[]>(url, {
      ...params,
      page: 1,
      per_page: options.perPage ?? 100,
    });
  }

  async post<T>(url: string, body?: unknown): Promise<T> {
    this.calls.push({ method: 'POST', url, params: {}, body });
    return this.responses.post as T;
  }

  async patch<T>(url: string, body?: unknown): Promise<T> {
    this.calls.push({ method: 'PATCH', url, params: {}, body });
    return this.responses.patch as T;
  }

  async put<T>(url: string, body?: unknown): Promise<T> {
    this.calls.push({ method: 'PUT', url, params: {}, body });
    return this.responses.put as T;
  }

  async delete<T>(url: string, params?: QueryParams): Promise<T> {
    this.calls.push({ method: 'DELETE', url, params: params ?? {} });
    return this.responses.delete as T;
  }

  close(): void {
    // no-op
  }

  private filterByCreatedAt(comments: IssueCommentData[], since: unknown): IssueCommentData[] {
    if (!this.state.respectSince) return [...comments];
    const sinceMs = parseDate(since);
    if (sinceMs === null) return [...comments];
    return comments.filter(comment => (parseDate(comment.created_at) ?? 0) > sinceMs);
  }
}

export function asHttpClient(fake: FakeHttpClient): HttpClient {
  return fake as unknown as HttpClient;
}

export function lastCall(fake: FakeHttpClient): FakeCall | undefined {
  return fake.calls[fake.calls.length - 1];
}

export function parseDate(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

let issueSequence = 1;

export function makeIssue(overrides: Partial<IssueData> = {}): IssueData {
  const number = overrides.number ?? String(issueSequence++);
  const created = overrides.created_at ?? new Date(0).toISOString();
  return {
    id: Number(number),
    number,
    state: 'open',
    title: `Issue ${number}`,
    body: `Body ${number}`,
    created_at: created,
    updated_at: overrides.updated_at ?? created,
    comments: 0,
    ...overrides,
  };
}

export function makeIssueComment(
  overrides: Partial<IssueCommentData> & { issueNumber?: string | number } = {}
): IssueCommentData {
  const issueNumber = overrides.issueNumber ?? 1;
  return {
    id: overrides.id ?? 1,
    body: overrides.body ?? 'comment',
    created_at: overrides.created_at ?? new Date(0).toISOString(),
    target: { issue: { number: issueNumber } },
    ...overrides,
  };
}

export function makePullRequest(overrides: Partial<PullRequestData> = {}): PullRequestData {
  const number = overrides.number ?? 1;
  const created = overrides.created_at ?? new Date(0).toISOString();
  return {
    number,
    state: 'open',
    title: `PR ${number}`,
    created_at: created,
    updated_at: overrides.updated_at ?? created,
    notes: 0,
    head: { sha: 'head-1' },
    base: { sha: 'base-1' },
    ...overrides,
  };
}

export function makePrComment(
  overrides: Partial<PullRequestCommentData> = {}
): PullRequestCommentData {
  return {
    id: overrides.id ?? 1,
    body: overrides.body ?? 'comment',
    comment_type: 'pr_comment',
    created_at: overrides.created_at ?? new Date(0).toISOString(),
    ...overrides,
  };
}

export function makeCommit(overrides: Partial<CommitData> = {}): CommitData {
  const date = overrides.author?.date ?? new Date(0).toISOString();
  return {
    sha: overrides.sha ?? 'sha-1',
    commit: {
      message: 'commit',
      author: { date },
    },
    author: { login: 'tester', date },
    ...overrides,
  };
}

export function makeFileDiff(overrides: Partial<FileDiffData> = {}): FileDiffData {
  return {
    filename: overrides.filename ?? 'file.txt',
    status: overrides.status ?? 'modified',
    ...overrides,
  };
}
