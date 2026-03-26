import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Logger, LogLevel, getLogger, logger, setLogger, type LogEntry } from '../src/logger';
import { sleep } from '../src/utils/concurrency';

test('Logger filters levels and formats args/scope', () => {
  const entries: LogEntry[] = [];
  const log = new Logger({
    console: false,
    level: LogLevel.INFO,
    timestamp: () => 'T',
    sink: entry => entries.push(entry),
  });

  log.debug('hidden');
  log.info('hello', { a: 1 });
  log.child('repo').child('issues').warn('scoped', 'text');
  log.error('failure', new Error('boom'));

  assert.equal(entries.length, 3);
  assert.equal(entries[0].level, LogLevel.INFO);
  assert.equal(entries[0].line, '[T][INFO] hello {"a":1}');
  assert.equal(entries[1].line, '[T][WARN][repo/issues] scoped text');
  assert.equal(entries[2].level, LogLevel.ERROR);
  assert.match(entries[2].line, /failure Error: boom/);

  log.setLevel(LogLevel.DEBUG);
  log.debug('visible');
  assert.equal(entries.length, 4);
});

test('Logger handles circular values and null/undefined args', () => {
  const entries: LogEntry[] = [];
  const log = new Logger({
    console: false,
    timestamp: () => 'T',
    sink: entry => entries.push(entry),
  });
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  assert.doesNotThrow(() => log.info('circular', circular, null, undefined));
  assert.match(entries[0].line, /circular \[object Object\] null/);
});

test('Logger writes to a file without creating one by default', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'gitcode-sdk-log-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const filePath = path.join(directory, 'nested', 'sdk.log');
  const log = new Logger({
    console: false,
    filePath,
    timestamp: () => 'T',
  });

  log.info('file line');

  let content = '';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await sleep(10);
    try {
      content = readFileSync(filePath, 'utf8');
      if (content) break;
    } catch {
      // 文件尚未创建，继续等待。
    }
  }
  log.close();

  assert.match(content, /^\[T\]\[INFO\] file line\n$/);
});

test('setLogger replaces the default logger used by the logger proxy', () => {
  const previous = getLogger();
  const entries: LogEntry[] = [];
  const custom = new Logger({
    console: false,
    timestamp: () => 'T',
    sink: entry => entries.push(entry),
  });

  try {
    setLogger(custom);
    logger.info('forwarded');
    logger.child('scope').error('nested');

    assert.equal(entries.length, 2);
    assert.equal(entries[0].line, '[T][INFO] forwarded');
    assert.equal(entries[1].line, '[T][ERROR][scope] nested');
  } finally {
    setLogger(previous);
  }
});
