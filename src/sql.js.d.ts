declare module "sql.js" {
  export type SqlValue = string | number | Uint8Array | null;
  export type BindParams = SqlValue[] | Record<string, SqlValue>;

  export interface QueryExecResult {
    columns: string[];
    values: SqlValue[][];
  }

  export class Statement {
    bind(values?: BindParams): boolean;
    step(): boolean;
    get(params?: BindParams): SqlValue[];
    getAsObject(params?: BindParams): Record<string, SqlValue>;
    free(): boolean;
  }

  export class Database {
    constructor(data?: Uint8Array | ArrayLike<number>);
    run(sql: string, params?: BindParams): Database;
    exec(sql: string, params?: BindParams): QueryExecResult[];
    prepare(sql: string, params?: BindParams): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: typeof Database;
  }

  export default function initSqlJs(
    config?: Record<string, unknown>
  ): Promise<SqlJsStatic>;
}
