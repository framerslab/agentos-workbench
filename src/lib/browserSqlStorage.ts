import type { StorageAdapter } from "@framers/sql-storage-adapter/types";
import { IndexedDbAdapter, type IndexedDbAdapterOptions } from "@framers/sql-storage-adapter";
// The wasm must come from the same sql.js release as the glue code the adapter imports: a
// wasm from another release lacks the exports the glue calls ("dd.O is not a function").
import sqlWasmUrl from "sql.js/dist/sql-wasm-browser.wasm?url";

function locateSqlJsFile(file: string): string {
  if (file.endsWith(".wasm")) {
    return sqlWasmUrl;
  }
  return file;
}

export interface BrowserSqlStorageOptions extends Omit<IndexedDbAdapterOptions, "sqlJsConfig"> {
  sqlJsConfig?: IndexedDbAdapterOptions["sqlJsConfig"];
}

export function createBrowserSqlStorageAdapter(options: BrowserSqlStorageOptions = {}): StorageAdapter {
  const sqlJsConfig =
    options.sqlJsConfig && typeof options.sqlJsConfig === "object"
      ? (options.sqlJsConfig as Record<string, unknown>)
      : {};

  return new IndexedDbAdapter({
    autoSave: true,
    ...options,
    sqlJsConfig: {
      ...sqlJsConfig,
      locateFile: locateSqlJsFile
    }
  });
}
