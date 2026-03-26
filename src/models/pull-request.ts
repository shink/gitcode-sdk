import { isGitCodeApiError } from '../core/errors';
import type { HttpClient } from '../http/http-client';
import type {
  CommitData,
  CreatePullRequestParams,
  FileDiffData,
  ListCommitsParams,
  ListPullRequestCommentsParams,
  ListPullRequestsParams,
  MergePullRequestParams,
  MergePullRequestResult,
  PullRequestCommentData,
  PullRequestData,
  QueryParams,
  Repository,
  UpdatePullRequestParams,
} from '../types';
import { toIsoDate } from '../utils/time';
import { repoPath } from '../utils/url';
import { labelsToParam } from './params';

/**
 * Pull Request 资源。
 *
 * 与旧版本相比的主要修复：
 * - list() 默认 per_page=100，并提供 listAll()；
 * - getComments()/getCommits() 自动翻页；
 * - update() 合并响应而不是整体替换（PATCH 可能返回部分字段）；
 * - merge() 按官方字段发送 merge_method/title/description 等参数。
 */
export class PullRequest {
  constructor(
    private readonly http: HttpClient,
    private readonly repo: Repository,
    public data: PullRequestData
  ) {}

  get number(): number {
    return this.data.number;
  }

  get title(): string {
    return this.data.title;
  }

  get state(): string {
    return this.data.state;
  }

  get htmlUrl(): string | undefined {
    return this.data.html_url ?? this.data.web_url;
  }

  /** 重新获取 PR 详情，并与本地数据合并。 */
  async refresh(): Promise<PullRequestData> {
    const data = await this.http.get<PullRequestData>(this.url());
    this.data = { ...this.data, ...data };
    return this.data;
  }

  async createComment(body: string): Promise<PullRequestCommentData> {
    return this.http.post<PullRequestCommentData>(`${this.url()}/comments`, { body });
  }

  /** 获取全部评论（自动翻页）。 */
  async getComments(params: ListPullRequestCommentsParams = {}): Promise<PullRequestCommentData[]> {
    return this.listComments({ ...params, all: params.all ?? true });
  }

  async listComments(
    params: ListPullRequestCommentsParams = {}
  ): Promise<PullRequestCommentData[]> {
    const url = `${this.url()}/comments`;
    const query: QueryParams = {
      page: params.page,
      per_page: params.perPage,
      direction: params.direction,
      comment_type: params.commentType,
    };

    if (params.all) {
      return this.http.getAll<PullRequestCommentData>(url, query, {
        maxPages: params.maxPages,
      });
    }
    return this.http.get<PullRequestCommentData[]>(url, query);
  }

  /** 获取全部提交（自动翻页）。 */
  async getCommits(params: ListCommitsParams = {}): Promise<CommitData[]> {
    const url = `${this.url()}/commits`;
    const query: QueryParams = {
      page: params.page,
      per_page: params.perPage,
    };

    if (params.all ?? true) {
      return this.http.getAll<CommitData>(url, query, { maxPages: params.maxPages });
    }
    return this.http.get<CommitData[]>(url, query);
  }

  /**
   * 获取 PR 文件 diff。
   *
   * 注意：GitCode 的 files 接口可能忽略 per_page 并一次返回全部文件
   * （实测大 PR 可返回 599 个文件），因此这里不做自动翻页。
   */
  async getFiles(params: { page?: number; perPage?: number } = {}): Promise<FileDiffData[]> {
    return this.http.get<FileDiffData[]>(`${this.url()}/files`, {
      page: params.page,
      per_page: params.perPage ?? 100,
    });
  }

  async update(params: UpdatePullRequestParams): Promise<PullRequestData> {
    const body = buildUpdateBody(params);
    if (Object.keys(body).length === 0) {
      throw new TypeError('PullRequest.update requires at least one field');
    }

    const data = await this.http.patch<PullRequestData>(this.url(), body);
    this.data = { ...this.data, ...data };
    return this.data;
  }

  /**
   * 合并 PR。
   *
   * 传字符串时兼容旧版本语义，作为合并标题发送（旧版发送的 message 字段
   * 并不会被 GitCode 使用）。
   */
  async merge(params?: string | MergePullRequestParams): Promise<MergePullRequestResult> {
    return this.http.put<MergePullRequestResult>(`${this.url()}/merge`, buildMergeBody(params));
  }

  async isMerged(): Promise<boolean> {
    try {
      const result = await this.http.get<{ merged?: number | boolean }>(`${this.url()}/merge`);
      return Boolean(result.merged);
    } catch (error) {
      // GitCode 对“未合并”的 PR 返回 404，而不是 merged=false。
      if (isGitCodeApiError(error) && error.status === 404) return false;
      throw error;
    }
  }

  async close(): Promise<PullRequestData> {
    return this.update({ state: 'closed' });
  }

  async reopen(): Promise<PullRequestData> {
    return this.update({ state: 'open' });
  }

  static async create(
    http: HttpClient,
    repo: Repository,
    params: CreatePullRequestParams
  ): Promise<PullRequest> {
    const url = repoPath(repo, 'pulls');
    const data = await http.post<PullRequestData>(url, buildCreateBody(params));
    return new PullRequest(http, repo, data);
  }

  /** 获取单页 PR（默认 per_page=100）。需要全部数据时使用 listAll()。 */
  static async list(
    http: HttpClient,
    repo: Repository,
    params: ListPullRequestsParams = {}
  ): Promise<PullRequest[]> {
    const url = repoPath(repo, 'pulls');
    const data = await http.get<PullRequestData[]>(url, buildListQuery(params));
    return data.map(item => new PullRequest(http, repo, item));
  }

  static async listAll(
    http: HttpClient,
    repo: Repository,
    params: ListPullRequestsParams = {}
  ): Promise<PullRequest[]> {
    const url = repoPath(repo, 'pulls');
    const data = await http.getAll<PullRequestData>(url, buildListQuery(params, false), {
      maxPages: params.maxPages,
    });
    return data.map(item => new PullRequest(http, repo, item));
  }

  static async get(http: HttpClient, repo: Repository, number: number): Promise<PullRequest> {
    const data = await http.get<PullRequestData>(repoPath(repo, 'pulls', number));
    return new PullRequest(http, repo, data);
  }

  private url(): string {
    return repoPath(this.repo, 'pulls', this.number);
  }
}

function buildListQuery(params: ListPullRequestsParams, includePagination = true): QueryParams {
  return {
    state: params.state,
    base: params.base,
    since: toIsoDate(params.since),
    sort: params.sort,
    direction: params.direction,
    milestone_number: params.milestoneNumber,
    labels: labelsToParam(params.labels),
    author: params.author,
    assignee: params.assignee,
    reviewer: params.reviewer,
    merged_after: toIsoDate(params.mergedAfter),
    merged_before: toIsoDate(params.mergedBefore),
    created_after: toIsoDate(params.createdAfter),
    created_before: toIsoDate(params.createdBefore),
    updated_after: toIsoDate(params.updatedAfter),
    updated_before: toIsoDate(params.updatedBefore),
    page: includePagination ? params.page : undefined,
    per_page: includePagination ? (params.perPage ?? 100) : undefined,
  };
}

function buildCreateBody(params: CreatePullRequestParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: params.title,
    head: params.head,
    base: params.base,
  };

  if (params.body !== undefined) body.body = params.body;
  if (params.draft !== undefined) body.draft = params.draft;
  if (params.labels !== undefined) body.labels = labelsToParam(params.labels);
  if (params.assignee !== undefined) body.assignee = params.assignee;
  if (params.testers !== undefined) body.testers = params.testers;
  if (params.milestoneNumber !== undefined) {
    body.milestone_number = params.milestoneNumber;
  }

  return body;
}

function buildUpdateBody(params: UpdatePullRequestParams): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (params.title !== undefined) body.title = params.title;
  if (params.body !== undefined) body.body = params.body;
  if (params.state !== undefined) body.state = params.state;
  if (params.labels !== undefined) body.labels = labelsToParam(params.labels);
  if (params.milestoneNumber !== undefined) {
    body.milestone_number = params.milestoneNumber;
  }
  if (params.draft !== undefined) body.draft = params.draft;
  if (params.closeRelatedIssue !== undefined) {
    body.close_related_issue = params.closeRelatedIssue;
  }
  if (params.pruneBranch !== undefined) body.prune_branch = params.pruneBranch;
  if (params.squashMerge !== undefined) body.squash_merge = params.squashMerge;

  return body;
}

function buildMergeBody(params?: string | MergePullRequestParams): Record<string, unknown> {
  if (params === undefined) return {};
  if (typeof params === 'string') return { title: params };

  const body: Record<string, unknown> = {};
  if (params.mergeMethod !== undefined) body.merge_method = params.mergeMethod;
  if (params.title !== undefined) body.title = params.title;
  if (params.description !== undefined) body.description = params.description;
  if (params.forceMerge !== undefined) body.force_merge = params.forceMerge;
  if (params.squash !== undefined) body.squash = params.squash;
  if (params.squashCommitMessage !== undefined) {
    body.squash_commit_message = params.squashCommitMessage;
  }
  return body;
}
