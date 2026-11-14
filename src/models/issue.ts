import type { HttpClient } from '../http/http-client';
import type {
  CreateIssueParams,
  IssueCommentData,
  IssueData,
  ListIssueCommentsParams,
  ListIssuesParams,
  QueryParams,
  Repository,
  UpdateIssueParams,
} from '../types';
import { toIsoDate } from '../utils/time';
import { repoPath } from '../utils/url';
import { labelsToParam } from './params';

/**
 * Issue 资源。
 *
 * - list() 默认 per_page=100；
 * - listAll() 自动翻页获取全部 Issue；
 * - getComments() 默认获取全部评论；
 * - close()/reopen() 使用 GitCode 实际支持的 state=close/reopen。
 */
export class Issue {
  constructor(
    private readonly http: HttpClient,
    private readonly repo: Repository,
    public data: IssueData
  ) {}

  get number(): string {
    return String(this.data.number);
  }

  get title(): string {
    return this.data.title;
  }

  get state(): string {
    return this.data.state;
  }

  get htmlUrl(): string | undefined {
    return this.data.html_url;
  }

  /** 重新获取 Issue 详情，并与本地数据合并。 */
  async refresh(): Promise<IssueData> {
    const data = await this.http.get<IssueData>(this.url());
    this.data = { ...this.data, ...data };
    return this.data;
  }

  async createComment(body: string): Promise<IssueCommentData> {
    return this.http.post<IssueCommentData>(`${this.url()}/comments`, { body });
  }

  /** 获取全部评论（自动翻页）。大仓库中请优先使用 listComments() 分页。 */
  async getComments(params: ListIssueCommentsParams = {}): Promise<IssueCommentData[]> {
    return this.listComments({ ...params, all: params.all ?? true });
  }

  async listComments(params: ListIssueCommentsParams = {}): Promise<IssueCommentData[]> {
    const url = `${this.url()}/comments`;
    const query: QueryParams = {
      page: params.page,
      per_page: params.perPage,
      since: toIsoDate(params.since),
      order: params.order,
    };

    if (params.all) {
      return this.http.getAll<IssueCommentData>(url, query, {
        maxPages: params.maxPages,
      });
    }
    return this.http.get<IssueCommentData[]>(url, query);
  }

  /**
   * 更新 Issue。GitCode 的 Issue PATCH 接口使用 `state=close|reopen`。
   */
  async update(params: UpdateIssueParams): Promise<IssueData> {
    const body = buildUpdateBody(params);
    if (Object.keys(body).length === 0) {
      throw new TypeError('Issue.update requires at least one field');
    }

    const data = await this.http.patch<IssueData>(this.url(), body);
    this.data = { ...this.data, ...data };
    return this.data;
  }

  async close(): Promise<IssueData> {
    return this.update({ state: 'close' });
  }

  async reopen(): Promise<IssueData> {
    return this.update({ state: 'reopen' });
  }

  static async create(
    http: HttpClient,
    repo: Repository,
    params: CreateIssueParams
  ): Promise<Issue> {
    const url = repoPath(repo, 'issues');
    const data = await http.post<IssueData>(url, buildCreateBody(params));
    return new Issue(http, repo, data);
  }

  /** 获取单页 Issue（默认 per_page=100）。需要全部数据时使用 listAll()。 */
  static async list(
    http: HttpClient,
    repo: Repository,
    params: ListIssuesParams = {}
  ): Promise<Issue[]> {
    const url = repoPath(repo, 'issues');
    const data = await http.get<IssueData[]>(url, buildListQuery(params));
    return data.map(item => new Issue(http, repo, item));
  }

  static async listAll(
    http: HttpClient,
    repo: Repository,
    params: ListIssuesParams = {}
  ): Promise<Issue[]> {
    const url = repoPath(repo, 'issues');
    const data = await http.getAll<IssueData>(url, buildListQuery(params, false), {
      maxPages: params.maxPages,
    });
    return data.map(item => new Issue(http, repo, item));
  }

  static async get(http: HttpClient, repo: Repository, number: number | string): Promise<Issue> {
    const data = await http.get<IssueData>(repoPath(repo, 'issues', number));
    return new Issue(http, repo, data);
  }

  private url(): string {
    return repoPath(this.repo, 'issues', this.number);
  }
}

function buildListQuery(params: ListIssuesParams, includePagination = true): QueryParams {
  return {
    state: params.state,
    labels: labelsToParam(params.labels),
    sort: params.sort,
    direction: params.direction,
    since: toIsoDate(params.since),
    created_after: toIsoDate(params.createdAfter),
    created_before: toIsoDate(params.createdBefore),
    updated_after: toIsoDate(params.updatedAfter),
    updated_before: toIsoDate(params.updatedBefore),
    milestone: params.milestone,
    assignee: params.assignee,
    creator: params.creator,
    search: params.search,
    page: includePagination ? params.page : undefined,
    per_page: includePagination ? (params.perPage ?? 100) : undefined,
  };
}

function buildCreateBody(params: CreateIssueParams): Record<string, unknown> {
  const body: Record<string, unknown> = { title: params.title };

  if (params.body !== undefined) body.body = params.body;
  if (params.labels !== undefined) body.labels = labelsToParam(params.labels);
  if (params.assignee !== undefined) body.assignee = params.assignee;
  if (params.milestone !== undefined) body.milestone = params.milestone;
  if (params.securityHole !== undefined) {
    body.security_hole = String(params.securityHole);
  }
  if (params.issueType !== undefined) body.issue_type = params.issueType;
  if (params.issueSeverity !== undefined) body.issue_severity = params.issueSeverity;

  return body;
}

function buildUpdateBody(params: UpdateIssueParams): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (params.title !== undefined) body.title = params.title;
  if (params.body !== undefined) body.body = params.body;
  if (params.state !== undefined) {
    body.state = params.state;
  }
  if (params.labels !== undefined) body.labels = labelsToParam(params.labels);
  if (params.assignee !== undefined) body.assignee = params.assignee;
  if (params.milestone !== undefined) body.milestone = params.milestone;

  return body;
}
