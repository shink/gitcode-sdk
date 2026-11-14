import { normalizeRepository } from './core/config';
import { HttpClient } from './http/http-client';
import { Issue } from './models/issue';
import { PullRequest } from './models/pull-request';
import type {
  CreateIssueParams,
  CreatePullRequestParams,
  GitCodeConfig,
  GitCodeUser,
  ListIssuesParams,
  ListPullRequestsParams,
  Repository,
} from './types';

/**
 * 不带轮询的轻量客户端门面。
 *
 * 这是只读/按需调用场景的推荐入口；只有需要事件监听时才使用 GitCodeApp。
 *
 * ```ts
 * const client = new GitCodeClient({ token });
 * const repo = client.repo({ owner: 'jiyuanhao', repo: 'hcomm' });
 * const issues = await repo.issues.list({ state: 'open' });
 * ```
 */
export class GitCodeClient {
  readonly http: HttpClient;
  private readonly ownsHttpClient: boolean;

  constructor(config: GitCodeConfig);
  constructor(http: HttpClient);
  /** 复用已有 HttpClient（便于测试或与 App 共享连接）。 */
  constructor(config: GitCodeConfig, http: HttpClient);
  constructor(input: GitCodeConfig | HttpClient, injectedHttpClient?: HttpClient) {
    if (injectedHttpClient) {
      this.http = injectedHttpClient;
      this.ownsHttpClient = false;
    } else if (input instanceof HttpClient) {
      this.http = input;
      this.ownsHttpClient = false;
    } else {
      this.http = new HttpClient(input);
      this.ownsHttpClient = true;
    }
  }

  repo(repo: Repository): GitCodeRepo {
    return new GitCodeRepo(this.http, normalizeRepository(repo));
  }

  getCurrentUser(): Promise<GitCodeUser> {
    return this.http.get<GitCodeUser>('/user');
  }

  /** 释放本客户端创建的连接；注入的 HttpClient 不会被关闭。 */
  close(): void {
    if (this.ownsHttpClient) this.http.close();
  }
}

/** 绑定到具体仓库的资源集合。 */
export class GitCodeRepo {
  readonly issues: IssueApi;
  readonly pulls: PullRequestApi;

  constructor(
    http: HttpClient,
    readonly repo: Repository
  ) {
    this.issues = new IssueApi(http, repo);
    this.pulls = new PullRequestApi(http, repo);
  }
}

export class IssueApi {
  constructor(
    private readonly http: HttpClient,
    private readonly repo: Repository
  ) {}

  create(params: CreateIssueParams): Promise<Issue> {
    return Issue.create(this.http, this.repo, params);
  }

  list(params: ListIssuesParams = {}): Promise<Issue[]> {
    return Issue.list(this.http, this.repo, params);
  }

  listAll(params: ListIssuesParams = {}): Promise<Issue[]> {
    return Issue.listAll(this.http, this.repo, params);
  }

  get(number: number | string): Promise<Issue> {
    return Issue.get(this.http, this.repo, number);
  }
}

export class PullRequestApi {
  constructor(
    private readonly http: HttpClient,
    private readonly repo: Repository
  ) {}

  create(params: CreatePullRequestParams): Promise<PullRequest> {
    return PullRequest.create(this.http, this.repo, params);
  }

  list(params: ListPullRequestsParams = {}): Promise<PullRequest[]> {
    return PullRequest.list(this.http, this.repo, params);
  }

  listAll(params: ListPullRequestsParams = {}): Promise<PullRequest[]> {
    return PullRequest.listAll(this.http, this.repo, params);
  }

  get(number: number): Promise<PullRequest> {
    return PullRequest.get(this.http, this.repo, number);
  }
}
