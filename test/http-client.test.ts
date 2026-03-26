import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { GitCodeApiError } from '../src/core/errors';
import { HttpClient } from '../src/http/http-client';

interface TestServer {
  server: http.Server;
  baseUrl: string;
}

async function listen(handler: http.RequestListener): Promise<TestServer> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/api/v5`,
  };
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function queryOf(request: http.IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://127.0.0.1');
}

test('HttpClient sends auth header, query params and user agent', async t => {
  const { server, baseUrl } = await listen((request, response) => {
    const url = queryOf(request);
    json(response, 200, {
      authorization: request.headers.authorization,
      userAgent: request.headers['user-agent'],
      path: url.pathname,
      state: url.searchParams.get('state'),
      perPage: url.searchParams.get('per_page'),
    });
  });
  const client = new HttpClient({ token: 'secret-token', baseUrl });
  t.after(async () => {
    client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const result = await client.get<{
    authorization: string;
    userAgent: string;
    path: string;
    state: string;
    perPage: string;
  }>('/repos/owner/repo/issues', { state: 'open', per_page: 100 });

  assert.equal(result.authorization, 'Bearer secret-token');
  assert.match(result.userAgent, /^gitcode-sdk\//);
  assert.equal(result.path, '/api/v5/repos/owner/repo/issues');
  assert.equal(result.state, 'open');
  assert.equal(result.perPage, '100');
});

test('HttpClient retries retryable status codes', async t => {
  let attempts = 0;
  const { server, baseUrl } = await listen((_request, response) => {
    attempts += 1;
    if (attempts < 3) {
      json(response, 503, { error_message: 'temporary' });
    } else {
      json(response, 200, { ok: true });
    }
  });
  const client = new HttpClient({
    token: 't',
    baseUrl,
    retries: 2,
    retryDelayMs: 1,
  });
  t.after(async () => {
    client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const result = await client.get<{ ok: boolean }>('/retry');
  assert.equal(result.ok, true);
  assert.equal(attempts, 3);
});

test('HttpClient does not retry 404 and maps error payload', async t => {
  let attempts = 0;
  const { server, baseUrl } = await listen((_request, response) => {
    attempts += 1;
    json(response, 404, {
      error_code: 404,
      error_code_name: 'UN_KNOW',
      error_message: 'Issue Not Found',
      trace_id: 'trace-123',
    });
  });
  const client = new HttpClient({ token: 't', baseUrl, retryDelayMs: 1 });
  t.after(async () => {
    client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  await assert.rejects(client.get('/missing'), (error: unknown) => {
    assert.ok(error instanceof GitCodeApiError);
    assert.equal(error.status, 404);
    assert.equal(error.code, 404);
    assert.equal(error.codeName, 'UN_KNOW');
    assert.equal(error.traceId, 'trace-123');
    assert.match(error.message, /Issue Not Found/);
    return true;
  });
  assert.equal(attempts, 1);
});

test('HttpClient retries POST only when explicitly configured', async t => {
  let attempts = 0;
  const { server, baseUrl } = await listen((_request, response) => {
    attempts += 1;
    json(response, 503, { error_message: 'temporary' });
  });
  const client = new HttpClient({
    token: 't',
    baseUrl,
    retries: 5,
    retryDelayMs: 1,
  });
  t.after(async () => {
    client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  await assert.rejects(client.post('/comments', { body: 'x' }));
  assert.equal(attempts, 1);

  attempts = 0;
  await assert.rejects(client.post('/comments', { body: 'x' }, { retries: 2 }));
  assert.equal(attempts, 3);
});

test('HttpClient treats non-finite retries as zero', async t => {
  let attempts = 0;
  const { server, baseUrl } = await listen((_request, response) => {
    attempts += 1;
    json(response, 503, { error_message: 'temporary' });
  });
  const client = new HttpClient({ token: 't', baseUrl, retries: 2, retryDelayMs: 1 });
  t.after(async () => {
    client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  await assert.rejects(client.get('/retry', undefined, { retries: Number.NaN }));
  assert.equal(attempts, 1);
});

test('HttpClient times out slow requests', async t => {
  const { server, baseUrl } = await listen((_request, response) => {
    setTimeout(() => {
      json(response, 200, { late: true });
    }, 200);
  });
  const client = new HttpClient({
    token: 't',
    baseUrl,
    timeoutMs: 20,
    retries: 0,
  });
  t.after(async () => {
    client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  await assert.rejects(client.get('/slow'), (error: unknown) => {
    assert.ok(error instanceof GitCodeApiError);
    assert.equal(error.status, undefined);
    return true;
  });
});

test('HttpClient.getAll paginates until a short page', async t => {
  const pages: Record<number, Array<{ id: number }>> = {
    1: [{ id: 1 }, { id: 2 }, { id: 3 }],
    2: [{ id: 4 }, { id: 5 }, { id: 6 }],
    3: [{ id: 7 }],
  };
  const requestedPages: number[] = [];
  const { server, baseUrl } = await listen((request, response) => {
    const url = queryOf(request);
    const page = Number(url.searchParams.get('page'));
    requestedPages.push(page);
    json(response, 200, pages[page] ?? []);
  });
  const client = new HttpClient({ token: 't', baseUrl });
  t.after(async () => {
    client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const items = await client.getAll<{ id: number }>('/items', {}, { perPage: 3 });
  assert.deepEqual(
    items.map(item => item.id),
    [1, 2, 3, 4, 5, 6, 7]
  );
  assert.deepEqual(requestedPages, [1, 2, 3]);
});

test('HttpClient.getAll stops when the server ignores per_page', async t => {
  let requests = 0;
  const { server, baseUrl } = await listen((_request, response) => {
    requests += 1;
    json(
      response,
      200,
      [1, 2, 3, 4, 5].map(id => ({ id }))
    );
  });
  const client = new HttpClient({ token: 't', baseUrl });
  t.after(async () => {
    client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const items = await client.getAll<{ id: number }>('/items', {}, { perPage: 3 });
  assert.equal(items.length, 5);
  assert.equal(requests, 1);
});

test('HttpClient.getAll stops on repeated page content', async t => {
  let requests = 0;
  const { server, baseUrl } = await listen((_request, response) => {
    requests += 1;
    json(response, 200, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  });
  const client = new HttpClient({ token: 't', baseUrl });
  t.after(async () => {
    client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const items = await client.getAll<{ id: number }>('/items', {}, { perPage: 3 });
  assert.equal(items.length, 3);
  assert.equal(requests, 2);
});

test('HttpClient.delete supports query params', async t => {
  const { server, baseUrl } = await listen((request, response) => {
    const url = queryOf(request);
    json(response, 200, {
      method: request.method,
      page: url.searchParams.get('page'),
    });
  });
  const client = new HttpClient({ token: 't', baseUrl });
  t.after(async () => {
    client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const result = await client.delete<{ method: string; page: string }>('/items/1', {
    page: 2,
  });
  assert.equal(result.method, 'DELETE');
  assert.equal(result.page, '2');
});

test('HttpClient validates configuration', () => {
  assert.throws(() => new HttpClient({ token: '   ' }), /token is required/);
  assert.throws(
    () => new HttpClient({ token: 't', retries: -1 }),
    /retries must be a non-negative/
  );
  assert.throws(
    () => new HttpClient({ token: 't', baseUrl: 'ftp://example.com' }),
    /must use http or https/
  );

  const client = new HttpClient({
    token: 't',
    baseUrl: 'http://127.0.0.1:1/api/v5/',
  });
  assert.equal(client.baseUrl, 'http://127.0.0.1:1/api/v5');
  client.close();
});
