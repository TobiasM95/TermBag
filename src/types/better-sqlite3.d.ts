declare module "better-sqlite3" {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface Statement {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  interface Transaction<TArgs extends unknown[]> {
    (...args: TArgs): void;
  }

  class Database {
    constructor(filename: string);
    pragma(value: string): void;
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): Statement;
    transaction<TArgs extends unknown[]>(fn: (...args: TArgs) => void): Transaction<TArgs>;
  }

  export default Database;
}
