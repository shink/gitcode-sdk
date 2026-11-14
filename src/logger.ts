import fs from 'node:fs';
import path from 'node:path';

/**
 * 日志级别。使用常量对象而不是 TS enum，既保持 LogLevel.DEBUG 的写法，
 * 也便于在纯 JS/类型擦除环境下使用。
 */
export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: '\x1b[36m',
  [LogLevel.INFO]: '\x1b[32m',
  [LogLevel.WARN]: '\x1b[33m',
  [LogLevel.ERROR]: '\x1b[31m',
};

const RESET_COLOR = '\x1b[0m';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  levelName: string;
  scope?: string;
  message: string;
  args: readonly unknown[];
  /** 不带颜色、可直接写入文件/自定义 sink 的完整行。 */
  line: string;
}

export type LoggerSink = (entry: LogEntry) => void;

export interface LoggerConfig {
  level?: LogLevel;
  /** 是否输出到 stdout/stderr，默认 true。 */
  console?: boolean;
  /** 日志文件路径；默认不写文件（避免库产生隐式副作用）。 */
  filePath?: string;
  /** 是否启用 ANSI 颜色；默认仅在 TTY 且未设置 NO_COLOR 时启用。 */
  color?: boolean;
  /** 自定义时间戳格式，默认 ISO 8601。 */
  timestamp?: () => string;
  /** 额外的日志 sink，可用于接入文件轮转、远程日志等。 */
  sink?: LoggerSink;
}

export interface LoggerLike {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  child(scope: string): LoggerLike;
  /** 可选：自定义 logger 可以不实现这些管理方法。 */
  setLevel?(level: LogLevel): void;
  setFilePath?(filePath?: string): void;
  close?(): void;
  isLevelEnabled?(level: LogLevel): boolean;
}

interface ResolvedLoggerConfig {
  level: LogLevel;
  console: boolean;
  color: boolean;
  filePath?: string;
  timestamp: () => string;
  sink?: LoggerSink;
}

class LoggerCore {
  private readonly config: ResolvedLoggerConfig;
  private stream: fs.WriteStream | null = null;

  constructor(config: Partial<LoggerConfig>) {
    this.config = {
      level: config.level ?? LogLevel.INFO,
      console: config.console !== false,
      color: config.color ?? (process.stdout.isTTY === true && process.env.NO_COLOR === undefined),
      filePath: config.filePath,
      timestamp: config.timestamp ?? (() => new Date().toISOString()),
      sink: config.sink,
    };

    if (this.config.filePath) {
      this.openFile(this.config.filePath);
    }
  }

  isEnabled(level: LogLevel): boolean {
    return level >= this.config.level;
  }

  write(level: LogLevel, scope: string, message: string, args: readonly unknown[]): void {
    if (!this.isEnabled(level)) return;

    const levelName = LEVEL_NAMES[level];
    const timestamp = this.config.timestamp();
    const scopeText = scope ? `[${scope}]` : '';
    const argsText = args.map(formatArg).filter(Boolean).join(' ');
    const text = [message, argsText].filter(Boolean).join(' ');
    const line = `[${timestamp}][${levelName}]${scopeText} ${text}`.trimEnd();

    if (this.config.console) {
      const output = this.config.color ? `${LEVEL_COLORS[level]}${line}${RESET_COLOR}` : line;
      if (level >= LogLevel.WARN) {
        process.stderr.write(`${output}\n`);
      } else {
        process.stdout.write(`${output}\n`);
      }
    }

    if (this.stream) {
      this.stream.write(`${line}\n`);
    }

    try {
      this.config.sink?.({
        timestamp,
        level,
        levelName,
        scope: scope || undefined,
        message,
        args,
        line,
      });
    } catch (error) {
      // 自定义 sink 不应影响主流程。
      process.stderr.write(
        `[gitcode-sdk] log sink error: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }

  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  setFilePath(filePath?: string): void {
    this.closeFile();
    this.config.filePath = filePath;
    if (filePath) this.openFile(filePath);
  }

  close(): void {
    this.closeFile();
  }

  private openFile(filePath: string): void {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });

    const stream = fs.createWriteStream(filePath, { flags: 'a' });
    stream.on('error', error => {
      process.stderr.write(`[gitcode-sdk] log stream error: ${error.message}\n`);
      if (this.stream === stream) this.stream = null;
    });
    this.stream = stream;
  }

  private closeFile(): void {
    if (!this.stream) return;
    this.stream.end();
    this.stream = null;
  }
}

export class Logger implements LoggerLike {
  private readonly core: LoggerCore;
  private scope = '';

  constructor(config: Partial<LoggerConfig> = {}) {
    this.core = new LoggerCore(config);
  }

  /**
   * 创建带作用域前缀的子日志器。子日志器共享父级的输出流、级别和 sink，
   * 因此不应单独对子日志器调用 close()。
   */
  child(scope: string): Logger {
    const child = Object.create(this) as unknown as Logger;
    child.scope = this.scope ? `${this.scope}/${scope}` : scope;
    return child;
  }

  debug(message: string, ...args: unknown[]): void {
    this.core.write(LogLevel.DEBUG, this.scope, message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.core.write(LogLevel.INFO, this.scope, message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.core.write(LogLevel.WARN, this.scope, message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.core.write(LogLevel.ERROR, this.scope, message, args);
  }

  isLevelEnabled(level: LogLevel): boolean {
    return this.core.isEnabled(level);
  }

  setLevel(level: LogLevel): void {
    this.core.setLevel(level);
  }

  setFilePath(filePath?: string): void {
    this.core.setFilePath(filePath);
  }

  close(): void {
    this.core.close();
  }
}

const defaultLogger = new Logger();
let activeLogger: LoggerLike = defaultLogger;

/** 获取当前默认日志器（会被 setLogger 替换）。 */
export function getLogger(): LoggerLike {
  return activeLogger;
}

/** 替换默认日志器；已显式传入 logger 的 App/Handler 不受影响。 */
export function setLogger(next: LoggerLike): void {
  activeLogger = next;
}

export function createLogger(config: Partial<LoggerConfig> = {}): Logger {
  return new Logger(config);
}

function formatArg(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'symbol':
      return value.description ?? 'Symbol';
    case 'function':
      return value.name ? `[Function ${value.name}]` : '[Function]';
    case 'object':
      break;
    default:
      return Object.prototype.toString.call(value);
  }

  if (value instanceof Error) return value.stack ?? value.message;
  if (value instanceof Date) return value.toISOString();

  try {
    const json = JSON.stringify(value);
    return json === undefined ? Object.prototype.toString.call(value) : json;
  } catch {
    // 循环引用、getter 抛错等场景不能影响日志主流程。
    return Object.prototype.toString.call(value);
  }
}
