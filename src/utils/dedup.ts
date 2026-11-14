/**
 * 有界集合，用于事件去重。
 *
 * 采用 Map 的插入顺序实现简单的 FIFO 淘汰；重复 add 会刷新其位置，因此
 * 在容量足够时行为接近 LRU。默认容量 10000，足以覆盖轮询窗口内的重复事件。
 */
export class BoundedSet {
  private readonly values = new Map<string, true>();

  constructor(private readonly maxSize = 10_000) {
    if (!Number.isFinite(maxSize) || maxSize < 1) {
      throw new TypeError('BoundedSet maxSize must be >= 1');
    }
  }

  get size(): number {
    return this.values.size;
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  add(key: string): void {
    if (this.values.has(key)) this.values.delete(key);
    this.values.set(key, true);
    while (this.values.size > this.maxSize) {
      const oldest = this.values.keys().next();
      if (oldest.done) break;
      this.values.delete(oldest.value);
    }
  }

  /** 如果 key 不存在则加入并返回 true；已存在返回 false。 */
  addIfNew(key: string): boolean {
    if (this.values.has(key)) return false;
    this.add(key);
    return true;
  }

  clear(): void {
    this.values.clear();
  }
}

/** 容量受限的 Map，用于缓存 PR/Issue 的处理状态。 */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly maxSize = 1_000) {
    if (!Number.isFinite(maxSize) || maxSize < 1) {
      throw new TypeError('LruCache maxSize must be >= 1');
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
