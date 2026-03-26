import type { HttpClient } from '../http/http-client';
import type { LoggerLike } from '../logger';
import { PullRequest } from '../models/pull-request';
import type { EventContext, EventType, PullRequestCommentData, Repository } from '../types';
import { mapLimit } from '../utils/concurrency';
import { LruCache } from '../utils/dedup';
import { isAfter, toTimestamp } from '../utils/time';
import {
  PollingState,
  reportHandlerError,
  resolveEventHandlerOptions,
  type EventHandlerOptions,
  type PollingWindow,
  type ResolvedEventHandlerOptions,
} from './polling-state';

export interface PRCheckResult {
  event: 'pr.opened' | 'pr.commented' | 'pr.commits';
  context: EventContext;
}

interface PrState {
  notes?: number;
  headSha?: string;
}

interface PrCheckOutcome {
  results: PRCheckResult[];
  failed: boolean;
}

/**
 * Pull Request 事件轮询器。
 *
 * 每轮先按 updated_at (since) 拉取发生变化的 PR，再根据 notes 数量与 head sha
 * 判断是否需要进一步获取评论/提交，避免每轮对所有 PR 做 N+1 请求。
 */
export class PullRequestEventHandler {
  private readonly options: ResolvedEventHandlerOptions;
  private readonly state: PollingState;
  private readonly log: LoggerLike;
  private readonly prStates = new LruCache<number, PrState>(2_000);

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
  ): Promise<PRCheckResult[]> {
    const wantsOpened = eventTypes.has('pr.opened');
    const wantsCommented = eventTypes.has('pr.commented');
    const wantsCommits = eventTypes.has('pr.commits');

    if (!wantsOpened && !wantsCommented && !wantsCommits) return [];

    const window = this.state.begin(now);
    if (!window) {
      this.log.debug('[pr] Baseline established; waiting for changes');
      return [];
    }

    let prs: PullRequest[];
    try {
      prs = await PullRequest.listAll(this.http, this.repo, {
        state: 'all',
        since: window.sinceIso,
        sort: 'updated',
        direction: 'desc',
        maxPages: this.options.maxPages,
      });
    } catch (error) {
      this.report('[pr] Failed to list pull requests', error);
      return [];
    }

    const outcomes = await mapLimit(
      prs,
      this.options.maxConcurrentRequests,
      async (pr): Promise<PrCheckOutcome> => {
        try {
          return await this.checkOne(pr, window, {
            wantsOpened,
            wantsCommented,
            wantsCommits,
          });
        } catch (error) {
          this.report(`[pr] Failed to process pull request #${pr.number}`, error);
          return { results: [], failed: true };
        }
      }
    );

    let failed = false;
    const results: PRCheckResult[] = [];
    for (const outcome of outcomes) {
      results.push(...outcome.results);
      failed = failed || outcome.failed;
    }

    if (!failed) this.state.commit(now);
    return results;
  }

  reset(now = this.options.clock()): void {
    this.state.reset(now);
    this.prStates.clear();
  }

  private async checkOne(
    pr: PullRequest,
    window: PollingWindow,
    wants: { wantsOpened: boolean; wantsCommented: boolean; wantsCommits: boolean }
  ): Promise<PrCheckOutcome> {
    const number = pr.number;
    const previous = this.prStates.get(number);
    const isNew = isAfter(pr.data.created_at, window.since);
    const currentNotes = typeof pr.data.notes === 'number' ? pr.data.notes : undefined;
    const currentHead = pr.data.head?.sha;
    const results: PRCheckResult[] = [];

    if (wants.wantsOpened && isNew && this.state.markSeen(`pr.opened:${number}`)) {
      this.log.info(`Detected opened pull request #${number}`, {
        title: pr.title,
      });
      results.push({
        event: 'pr.opened',
        context: {
          event: 'pr.opened',
          payload: pr.data,
          repo: this.repo,
          pullRequest: pr,
        },
      });
    }

    let nextNotes = currentNotes ?? previous?.notes;
    let nextHead = currentHead ?? previous?.headSha;
    let failed = false;

    const includeExisting = previous === undefined && this.options.emitExisting;
    if (
      wants.wantsCommented &&
      (shouldFetchComments(previous, isNew, currentNotes) || includeExisting)
    ) {
      try {
        const comments = await pr.getComments({
          all: true,
          maxPages: this.options.maxPages,
        });

        for (const comment of comments) {
          if (!this.isNewComment(comment, previous, isNew, window)) continue;
          if (!this.state.markSeen(`pr.comment:${number}:${comment.id}`)) continue;

          this.log.info(`Detected comment on pull request #${number}`, {
            commentId: comment.id,
            author: comment.user?.login,
          });
          results.push({
            event: 'pr.commented',
            context: {
              event: 'pr.commented',
              payload: { pullRequest: pr.data, comment },
              repo: this.repo,
              pullRequest: pr,
            },
          });
        }

        nextNotes = currentNotes ?? comments.length;
      } catch (error) {
        failed = true;
        this.report(`[pr] Failed to load comments for pull request #${number}`, error);
      }
    }

    const shouldFetchCommits =
      this.hasNewHead(previous, currentHead) ||
      (previous === undefined && this.options.emitExisting && !isNew);
    if (wants.wantsCommits && shouldFetchCommits) {
      try {
        const commits = await pr.getCommits({
          all: true,
          maxPages: this.options.maxPages,
        });

        for (const commit of commits) {
          const authoredAt = toTimestamp(commit.author?.date ?? commit.commit.author?.date);
          if (authoredAt === null || authoredAt <= window.since) continue;
          if (!this.state.markSeen(`pr.commit:${number}:${commit.sha}`)) continue;

          this.log.info(`Detected commit ${commit.sha.slice(0, 8)} on PR #${number}`);
          results.push({
            event: 'pr.commits',
            context: {
              event: 'pr.commits',
              payload: { pullRequest: pr.data, commit },
              repo: this.repo,
              pullRequest: pr,
            },
          });
        }

        nextHead = currentHead ?? previous?.headSha;
      } catch (error) {
        failed = true;
        this.report(`[pr] Failed to load commits for pull request #${number}`, error);
      }
    }

    // 只有该 PR 的评论/提交请求都成功后才更新缓存；失败时保留旧状态，
    // 下一轮重试（已发出的事件由去重集合拦截）。
    if (!failed) {
      this.prStates.set(number, { notes: nextNotes, headSha: nextHead });
    }

    return { results, failed };
  }

  private isNewComment(
    comment: PullRequestCommentData,
    previous: PrState | undefined,
    isNew: boolean,
    window: PollingWindow
  ): boolean {
    if (!previous) {
      // 首次看到的新 PR：其评论都属于新事件；emitExisting 模式下首次
      // 看到的存量 PR 仍按时间窗口过滤，避免补发全部历史评论。
      if (isNew) return true;
    }

    const createdAt = toTimestamp(comment.created_at);
    return createdAt !== null && createdAt > window.since;
  }

  private hasNewHead(previous: PrState | undefined, currentHead: string | undefined): boolean {
    return (
      previous !== undefined &&
      currentHead !== undefined &&
      previous.headSha !== undefined &&
      previous.headSha !== currentHead
    );
  }

  private report(message: string, error: unknown): void {
    reportHandlerError(this.log, this.options.onError, message, error);
  }
}

function shouldFetchComments(
  previous: PrState | undefined,
  isNew: boolean,
  currentNotes: number | undefined
): boolean {
  if (previous === undefined) return isNew;
  if (currentNotes === undefined) return true;
  if (previous.notes === undefined) return true;
  return currentNotes > previous.notes;
}
