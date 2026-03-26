// 公共类型定义：API 数据结构、请求参数、事件上下文与配置。

import type { Issue } from './models/issue';
import type { PullRequest } from './models/pull-request';
import type { HttpClient } from './http/http-client';
import type { LoggerLike } from './logger';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface GitCodeConfig {
  /** GitCode 访问令牌（Bearer Token）。 */
  token: string;
  /** API 基础地址，默认 https://api.gitcode.com/api/v5。 */
  baseUrl?: string;
  /** 单次请求超时（毫秒），默认 30000。 */
  timeoutMs?: number;
  /** 幂等请求失败后的重试次数，默认 2；POST 默认不重试。 */
  retries?: number;
  /** 重试基础退避时间（毫秒），默认 500。 */
  retryDelayMs?: number;
  /** 单次重试最大退避时间（毫秒），默认 10000。 */
  maxRetryDelayMs?: number;
  /** 自定义 User-Agent。 */
  userAgent?: string;
  /** 是否启用 HTTP keep-alive，默认 true。 */
  keepAlive?: boolean;
  /** keep-alive 最大连接数，默认 50。 */
  maxSockets?: number;
  /** 额外请求头。 */
  headers?: Record<string, string>;
}

export interface Repository {
  owner: string;
  repo: string;
}

// ---------------------------------------------------------------------------
// 通用 API 数据
// ---------------------------------------------------------------------------

export interface GitCodeUser {
  id?: string;
  login: string;
  name?: string;
  avatar_url?: string;
  html_url?: string;
  email?: string;
  type?: string;
  /** 部分提交接口会在 user 对象上直接返回日期。 */
  date?: string;
  [key: string]: unknown;
}

export interface GitCodeLabel {
  id?: number;
  name: string;
  color?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface GitCodeRepositoryRef {
  id?: number;
  full_name?: string;
  path?: string;
  name?: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface GitCodeRef {
  ref?: string;
  sha?: string;
  label?: string;
  user?: GitCodeUser;
  repo?: GitCodeRepositoryRef;
  [key: string]: unknown;
}

export interface GitCodeMilestone {
  id?: number;
  number?: number;
  title?: string;
  description?: string;
  state?: string;
  due_on?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export interface IssueData {
  id?: number;
  number: string;
  html_url?: string;
  state: string;
  title: string;
  body?: string;
  user?: GitCodeUser;
  assignees?: GitCodeUser[];
  repository?: GitCodeRepositoryRef;
  created_at: string;
  updated_at?: string;
  finished_at?: string;
  labels?: GitCodeLabel[];
  /** GitCode 返回的评论数量。 */
  comments?: number;
  issue_state?: string;
  priority?: number;
  issue_state_detail?: {
    title?: string;
    serial?: number;
    [key: string]: unknown;
  };
  issue_type?: string;
  issue_type_detail?: {
    title?: string;
    id?: number;
    is_system?: boolean;
    [key: string]: unknown;
  };
  issue_priority_detail?: {
    id?: string;
    title?: string;
    [key: string]: unknown;
  };
  milestone?: GitCodeMilestone | null;
  visibility_reason?: string;
  [key: string]: unknown;
}

export interface IssueCommentTarget {
  issue?: {
    id?: number;
    title?: string;
    number?: number | string;
    /** 兼容官方文档中的拼写错误字段。 */
    nubmer?: number | string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface IssueCommentData {
  id: number;
  body: string;
  user?: GitCodeUser;
  target?: IssueCommentTarget;
  created_at: string;
  updated_at?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Pull Request
// ---------------------------------------------------------------------------

export interface MergeableState {
  merge_request_id?: number;
  state?: boolean;
  status_without_user_auth?: boolean;
  conflict_passed?: boolean;
  [key: string]: unknown;
}

export interface PullRequestData {
  id?: number;
  number: number;
  html_url?: string;
  url?: string;
  issue_url?: string;
  state: string;
  title: string;
  body?: string;
  user?: GitCodeUser;
  assignees_number?: number;
  assignees?: Array<GitCodeUser | string>;
  testers_number?: number;
  testers?: Array<GitCodeUser | string>;
  approval_reviewers?: Array<GitCodeUser | string>;
  labels?: GitCodeLabel[];
  created_at: string;
  updated_at?: string;
  closed_at?: string;
  merged_at?: string;
  draft?: boolean;
  can_merge_check?: boolean;
  mergeable?: boolean;
  locked?: boolean;
  visibility_reason?: string;
  head?: GitCodeRef;
  base?: GitCodeRef;
  mergeable_state?: MergeableState | string | null;
  /** 列表接口返回的评论/备注数量。详情接口通常不返回。 */
  notes?: number;
  added_lines?: number;
  removed_lines?: number;
  close_related_issue?: boolean | number;
  prune_branch?: boolean;
  squash_merge?: boolean;
  target_branch?: string;
  source_branch?: string;
  web_url?: string;
  [key: string]: unknown;
}

export interface PullRequestDiffPosition {
  start_new_line?: number;
  end_new_line?: number;
  position_type?: string;
  [key: string]: unknown;
}

export interface PullRequestCommentData {
  id: number;
  body: string;
  user?: GitCodeUser;
  discussion_id?: string;
  comment_type?: string;
  resolved?: boolean;
  resolved_by?: GitCodeUser;
  diff_position?: PullRequestDiffPosition;
  created_at: string;
  updated_at?: string;
  [key: string]: unknown;
}

/** 兼容旧版本：Issue 与 PR 评论的联合类型。 */
export type CommentData = IssueCommentData | PullRequestCommentData;

// ---------------------------------------------------------------------------
// Commit / Diff
// ---------------------------------------------------------------------------

export interface GitCodeCommitPerson {
  login?: string;
  name?: string;
  email?: string;
  date?: string;
  [key: string]: unknown;
}

export interface CommitData {
  sha: string;
  html_url?: string;
  commit: {
    author?: GitCodeCommitPerson;
    committer?: GitCodeCommitPerson;
    message: string;
    [key: string]: unknown;
  };
  author?: GitCodeUser;
  committer?: GitCodeUser;
  parents?: Array<{ sha: string; html_url?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface PatchData {
  diff: string;
  old_path?: string;
  new_path?: string;
  a_mode?: string;
  b_mode?: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  too_large?: boolean;
  added_lines?: number;
  removed_lines?: number;
  [key: string]: unknown;
}

export interface FileDiffData {
  sha?: string;
  filename: string;
  status: string;
  additions?: number;
  deletions?: number;
  blob_id?: string;
  blob_url?: string;
  raw_url?: string;
  /** GitCode 通常返回 PatchData，部分版本返回原始 diff 字符串。 */
  patch?: PatchData | string;
  target_branch?: string;
  source_branch?: string;
  source_project?: GitCodeRepositoryRef;
  target_project?: GitCodeRepositoryRef;
  [key: string]: unknown;
}

export interface DiffData {
  url?: string;
  html_url?: string;
  diff_url?: string;
  patch_url?: string;
  merged_at?: string;
  mergeable?: boolean;
  mergeable_state?: string;
  merged_by?: { login: string; id: number };
  comments?: number;
  review_comments?: number;
  maintainer_can_modify?: boolean;
  commits?: number;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  files?: FileDiffData[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

export type EventType =
  | 'issue.opened'
  | 'issue.commented'
  | 'pr.opened'
  | 'pr.commented'
  | 'pr.commits';

export interface IssueCommentedPayload {
  issue: IssueData;
  comment: IssueCommentData;
}

export interface PrCommentedPayload {
  pullRequest: PullRequestData;
  comment: PullRequestCommentData;
}

export interface PrCommitsPayload {
  pullRequest: PullRequestData;
  commit: CommitData;
}

export interface IssueOpenedContext {
  event: 'issue.opened';
  payload: IssueData;
  repo: Repository;
  issue: Issue;
}

export interface IssueCommentedContext {
  event: 'issue.commented';
  payload: IssueCommentedPayload;
  repo: Repository;
  issue: Issue;
}

export interface PrOpenedContext {
  event: 'pr.opened';
  payload: PullRequestData;
  repo: Repository;
  pullRequest: PullRequest;
}

export interface PrCommentedContext {
  event: 'pr.commented';
  payload: PrCommentedPayload;
  repo: Repository;
  pullRequest: PullRequest;
}

export interface PrCommitsContext {
  event: 'pr.commits';
  payload: PrCommitsPayload;
  repo: Repository;
  pullRequest: PullRequest;
}

export type EventContext =
  | IssueOpenedContext
  | IssueCommentedContext
  | PrOpenedContext
  | PrCommentedContext
  | PrCommitsContext;

export type EventContextOf<E extends EventType> = Extract<EventContext, { event: E }>;

export type EventCallback = (context: EventContext) => void | Promise<void>;

/** 与具体事件类型绑定的回调；context 会按 event 自动收窄。 */
export type EventCallbackOf<E extends EventType> = (
  context: EventContextOf<E>
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// 轮询与 App 配置
// ---------------------------------------------------------------------------

export interface PollOptions {
  /** 轮询间隔（毫秒），默认 30000。 */
  interval?: number;
  /** 轮询间隔（毫秒），interval 的别名。 */
  intervalMs?: number;
}

export interface GitCodeAppOptions extends PollOptions {
  /** 构造时自动开始轮询，默认 true（兼容旧版本）；建议显式调用 start()。 */
  autoStart?: boolean;
  /**
   * 首次轮询是否补发 initialLookbackMs 内已存在的事件，默认 false。
   * 默认行为是建立基线，避免进程重启后重复处理历史事件。
   */
  emitExisting?: boolean;
  /** emitExisting 为 true 时的回看窗口，默认等于轮询间隔。 */
  initialLookbackMs?: number;
  /** 水位线重叠时间，用于抵消 API 索引延迟，默认 min(5000, intervalMs)。 */
  overlapMs?: number;
  /** 单次轮询最大回看时间，防止长时间失败后窗口无限扩大，默认 max(10*interval, 5min)。 */
  maxLookbackMs?: number;
  /** 单次分页请求的最大页数，默认 20。 */
  maxPages?: number;
  /** 单个轮询中并发处理 PR/Issue 的数量，默认 5。 */
  maxConcurrentRequests?: number;
  /** 注入自定义日志器。 */
  logger?: LoggerLike;
  /** 注入自定义 HttpClient（便于测试或复用连接）。 */
  httpClient?: HttpClient;
  /** 可注入时钟（毫秒），便于测试。 */
  clock?: () => number;
  /** 错误回调；事件处理器仍会记录日志。 */
  onError?: (error: unknown) => void;
  /** 轮询定时器是否 unref（不阻止进程退出），默认 false。 */
  unref?: boolean;
}

// ---------------------------------------------------------------------------
// 请求参数
// ---------------------------------------------------------------------------

export type DateInput = string | number | Date;
export type LabelsInput = string | readonly string[];

export type QueryPrimitive = string | number | boolean;
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[] | null | undefined;
export type QueryParams = Record<string, QueryValue>;

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

export interface PaginationOptions {
  perPage?: number;
  maxPages?: number;
  startPage?: number;
}

export interface ListIssuesParams {
  /** 常见值：open、closed、all。 */
  state?: string;
  labels?: LabelsInput;
  /** 常见值：created、updated。 */
  sort?: string;
  direction?: 'asc' | 'desc';
  since?: DateInput;
  createdAfter?: DateInput;
  createdBefore?: DateInput;
  updatedAfter?: DateInput;
  updatedBefore?: DateInput;
  milestone?: string | number;
  assignee?: string;
  creator?: string;
  search?: string;
  page?: number;
  perPage?: number;
  maxPages?: number;
}

export interface ListPullRequestsParams {
  /** 常见值：open、closed、locked、merged、all。 */
  state?: string;
  base?: string;
  since?: DateInput;
  /** 常见值：created、updated。 */
  sort?: string;
  direction?: 'asc' | 'desc';
  milestoneNumber?: number;
  labels?: LabelsInput;
  author?: string;
  assignee?: string;
  reviewer?: string;
  mergedAfter?: DateInput;
  mergedBefore?: DateInput;
  createdAfter?: DateInput;
  createdBefore?: DateInput;
  updatedAfter?: DateInput;
  updatedBefore?: DateInput;
  page?: number;
  perPage?: number;
  maxPages?: number;
}

export interface ListIssueCommentsParams {
  page?: number;
  perPage?: number;
  since?: DateInput;
  order?: 'asc' | 'desc';
  /** true 时自动翻页获取全部评论；getComments() 默认为 true。 */
  all?: boolean;
  maxPages?: number;
}

export interface ListPullRequestCommentsParams {
  page?: number;
  perPage?: number;
  direction?: 'asc' | 'desc';
  /** 常见值：pr_comment、diff_comment。 */
  commentType?: string;
  /** true 时自动翻页获取全部评论；getComments() 默认为 true。 */
  all?: boolean;
  maxPages?: number;
}

export interface ListCommitsParams {
  page?: number;
  perPage?: number;
  all?: boolean;
  maxPages?: number;
}

export interface CreateIssueParams {
  title: string;
  body?: string;
  labels?: LabelsInput;
  assignee?: string;
  milestone?: number;
  securityHole?: boolean | string;
  issueType?: string;
  issueSeverity?: string;
}

export interface UpdateIssueParams {
  title?: string;
  body?: string;
  /**
   * 关闭/重新打开 Issue。GitCode 的 Issue PATCH 接口使用 state=close/reopen，
   * 兼容传入 open/closed。
   */
  state?: 'open' | 'closed' | 'close' | 'reopen';
  labels?: LabelsInput;
  assignee?: string;
  milestone?: number;
}

export interface CreatePullRequestParams {
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
  labels?: LabelsInput;
  assignee?: string;
  testers?: string;
  milestoneNumber?: number;
}

export interface UpdatePullRequestParams {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  labels?: LabelsInput;
  milestoneNumber?: number;
  draft?: boolean;
  closeRelatedIssue?: boolean;
  pruneBranch?: boolean;
  squashMerge?: boolean;
}

export interface MergePullRequestParams {
  /** 常见值：merge、rebase。 */
  mergeMethod?: string;
  title?: string;
  description?: string;
  forceMerge?: boolean;
  squash?: boolean;
  squashCommitMessage?: string;
}

export interface MergePullRequestResult {
  sha?: string;
  merged?: number | boolean;
  message?: string;
  [key: string]: unknown;
}
