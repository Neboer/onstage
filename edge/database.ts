/** Minimal structural D1 types keep the domain layer independent of Vinext. */
export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Row>(column?: string): Promise<T | null>;
  all<T = Row>(): Promise<{ results: T[]; success: boolean; meta?: Record<string, unknown> }>;
  run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
}
export interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
}
// SQL result rows are checked by the schema; conversion to public DTOs is explicit.
export type Row = Record<string, any>;

export class DomainError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function now(): string { return new Date().toISOString(); }
export function cutoff(seconds: number): string { return new Date(Date.now() - seconds * 1000).toISOString(); }
export function newId(): string { return crypto.randomUUID().replaceAll("-", ""); }
export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function secret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function secretEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export class Transaction {
  readonly writes: Statement[] = [];
  constructor(readonly db: Database) {}
  first<T = Row>(sql: string, ...values: unknown[]): Promise<T | null> {
    return this.db.prepare(sql).bind(...values).first<T>();
  }
  async all<T = Row>(sql: string, ...values: unknown[]): Promise<T[]> {
    return (await this.db.prepare(sql).bind(...values).all<T>()).results;
  }
  async readBatch(queries: Array<{ sql: string; values?: unknown[] }>): Promise<Row[][]> {
    const results = await this.db.batch(queries.map(({ sql, values = [] }) => this.db.prepare(sql).bind(...values)));
    return results.map((result) => (result as { results: Row[] }).results);
  }
  async count(sql: string, ...values: unknown[]): Promise<number> {
    const row = await this.first(sql, ...values);
    return row ? Number(Object.values(row)[0]) : 0;
  }
  add(sql: string, ...values: unknown[]): void {
    this.writes.push(this.db.prepare(sql).bind(...values));
  }
}

/**
 * D1 batch is atomic but has no interactive BEGIN API. All domain writes use a
 * shared revision: read revision before authorization/state reads, then commit
 * an SQL batch whose first CHECK rejects a stale revision. A failed batch has
 * no state, rate-count, sequence, or event side effects. Do not bypass this for
 * domain writes, including operator actions. Heartbeat timestamps are separate
 * and never authorize a domain operation.
 *
 * This binding deliberately does not enable read replicas / unconstrained D1
 * sessions. Read operations also check revision before returning scoped data.
 */
export class AtomicDatabase {
  constructor(readonly db: Database) {}
  private async revision(): Promise<number> {
    const row = await this.db.prepare("SELECT revision FROM edge_state WHERE id=1").first<Row>();
    if (!row) throw new DomainError(503, "共享数据库尚未完成迁移，请联系维护者。");
    return Number(row.revision);
  }
  async run<T>(write: boolean, operation: (tx: Transaction) => Promise<T>): Promise<T> {
    const attempts = write ? 24 : 10;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const revision = await this.revision();
      const tx = new Transaction(this.db);
      let result: T;
      try {
        result = await operation(tx);
      } catch (error) {
        if (!(error instanceof DomainError) || await this.revision() === revision) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 60));
        continue;
      }
      if (!write || tx.writes.length === 0) {
        if (await this.revision() === revision) return result;
      } else {
        const guardId = newId();
        try {
          await this.db.batch([
            this.db.prepare("INSERT INTO transaction_guards(id,valid) VALUES(?,COALESCE((SELECT revision=? FROM edge_state WHERE id=1),0))").bind(guardId, revision),
            ...tx.writes,
            this.db.prepare("UPDATE edge_state SET revision=revision+1 WHERE id=1"),
            this.db.prepare("DELETE FROM transaction_guards WHERE id=?").bind(guardId),
          ]);
          return result;
        } catch (error) {
          // Only the deliberately named revision CHECK is retryable here. Do
          // not log errors containing SQL/bindings, cookie hashes, or messages.
          if (!String(error).includes("onstage_revision_guard")) throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 15 + Math.random() * Math.min(200, 35 * (attempt + 1))));
    }
    throw new DomainError(503, "房间正在同步其他操作，请稍后重试；发言请保留原消息 ID。");
  }
}
