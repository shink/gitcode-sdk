import type { HttpClient } from '../http/http-client';
import type { LoggerLike } from '../logger';
import { Issue } from '../models/issue';
import type { EventContext, EventType, IssueCommentData, Repository } from '../types';
import { mapLimit } from '../utils/concurrency';
import { LruCache } from '../utils/dedup';
import { toTimestamp } from '../utils/time';
import { repoPath } from '../utils/url';
import {
  PollingState,
  reportHandlerError,
  resolveEventHandlerOptions,
  type EventHandlerOptions,
  type PollingWindow,
  type ResolvedEventHandlerOptions,
} from './polling-state';

export interface IssueCheckResult {
  event: 'issue.opened' | 'issue.commented';
  context: EventContext;
}

/**
 * Issue 事件轮询器。
 *
 * 每轮只发送两个列表请求（与 Issue 数量无关）：
 * 1. /issues?state=all&created_after=... 获取新 Issue；
 * 2. /issues/comments?since=... 获取整个仓库的新 Issue 评论。
 *
 * 旧实现每轮会为每个 Issue 单独拉取评论，复杂度为 O(N)。
 */
export class IssueEventHandler {
  private readonly options: ResolvedEventHandlerOptions;
  private readonly state: PollingState;
  private readonly log: LoggerLike;
  private readonly issueCache = new LruCache<string, Issue>(500);

  constructor(
    private readonly http: HttpClient,
    private readonly repo: Repository,
    options: number | EventHandlerOptions = {}
  ) {
    this.options = resolveEventHandlerOptions(options);
    this.state = new PollingState(this.options, this.options.clock);
    this.log = this.options.logger.child(`${repo.owner}/${repo.repo}`);
  }

  get lastCheckedAt(): number {
    return this.state.lastCheckedAt;
  }

  async checkEvents(
    now = this.options.clock(),
    eventTypes: ReadonlySet<EventType> = new Set()
  ): Promise<IssueCheckResult[]> {
    const wantsOpened = eventTypes.has('issue.opened');
    const wantsCommented = eventTypes.has('issue.commented');

    if (!wantsOpened && !wantsCommented) return [];

    const window = this.state.begin(now);
    if (!window) {
      this.log.debug('[issue] Baseline established; waiting for changes');
      return [];
    }

    const results: IssueCheckResult[] = [];
    let failed = false;

    if (wantsOpened) {
      try {
        results.push(...(await this.checkOpened(window)));
      } catch (error) {
        failed = true;
        this.report('[issue] Failed to check opened issues', error);
      }
    }

    if (wantsCommented) {
      try {
        const outcome = await this.checkComments(window);
        results.push(...outcome.results);
        failed = failed || outcome.failed;
      } catch (error) {
        failed = true;
        this.report('[issue] Failed to check issue comments', error);
      }
    }

    if (!failed) this.state.commit(now);
    return results;
  }

  reset(now = this.options.clock()): void {
    this.state.reset(now);
    this.issueCache.clear();
  }

  private async checkOpened(window: PollingWindow): Promise<IssueCheckResult[]> {
    const issues = await Issue.listAll(this.http, this.repo, {
      state: 'all',
      createdAfter: window.sinceIso,
      sort: 'created',
      direction: 'asc',
      maxPages: this.options.maxPages,
    });

    const results: IssueCheckResult[] = [];

    for (const issue of issues) {
      const createdAt = toTimestamp(issue.data.created_at);
      if (createdAt === null || createdAt <= window.since) continue;
      if (!this.state.markSeen(`issue.opened:${issue.number}`)) continue;

      this.issueCache.set(issue.number, issue);
      this.log.info(`Detected opened issue #${issue.number}`, {
        title: issue.title,
      });

      results.push({
        event: 'issue.opened',
        context: {
          event: 'issue.opened',
          payload: issue.data,
          repo: this.repo,
          issue,
        },
      });
    }

    return results;
  }

  private async checkComments(
    window: PollingWindow
  ): Promise<{ results: IssueCheckResult[]; failed: boolean }> {
    const comments = await this.http.getAll<IssueCommentData>(
      repoPath(this.repo, 'issues', 'comments'),
      {
        since: window.sinceIso,
        sort: 'created',
        direction: 'asc',
      },
      { maxPages: this.options.maxPages }
    );

    const candidates = comments.filter(comment => {
      const createdAt = toTimestamp(comment.created_at);
      return (
        createdAt !== null &&
        createdAt > window.since &&
        !this.state.hasSeen(`issue.comment:${comment.id}`)
      );
    });
    if (candidates.length === 0) return { results: [], failed: false };

    const issueNumbers = [
      ...new Set(
        candidates
          .map(comment => getCommentIssueNumber(comment))
          .filter((value): value is string => value !== undefined)
      ),
    ];

    const issues = new Map<string, Issue>();
    let failed = false;
    await mapLimit(issueNumbers, this.options.maxConcurrentRequests, async number => {
      try {
        issues.set(number, await this.resolveIssue(number));
      } catch (error) {
        // 单个 Issue 取详情失败不应阻塞其他评论事件；水位线不推进，下一轮重试。
        failed = true;
        this.report(`[issue] Failed to load issue #${number} for comment context`, error);
      }
    });

    const results: IssueCheckResult[] = [];

    for (const comment of candidates) {
      const number = getCommentIssueNumber(comment);
      if (!number) continue;

      const issue = issues.get(number);
      if (!issue) continue;
      if (!this.state.markSeen(`issue.comment:${comment.id}`)) continue;

      this.log.info(`Detected comment on issue #${number}`, {
        commentId: comment.id,
        author: comment.user?.login,
      });

      results.push({
        event: 'issue.commented',
        context: {
          event: 'issue.commented',
          payload: { issue: issue.data, comment },
          repo: this.repo,
          issue,
        },
      });
    }

    return { results, failed };
  }

  private async resolveIssue(number: string): Promise<Issue> {
    const cached = this.issueCache.get(number);
    if (cached) return cached;

    const issue = await Issue.get(this.http, this.repo, number);
    this.issueCache.set(number, issue);
    return issue;
  }

  private report(message: string, error: unknown): void {
    reportHandlerError(this.log, this.options.onError, message, error);
  }
}

function getCommentIssueNumber(comment: IssueCommentData): string | undefined {
  const target = comment.target?.issue;
  const value = target?.number ?? target?.nubmer;
  return value === undefined || value === null ? undefined : String(value);
}
