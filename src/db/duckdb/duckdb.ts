import createDuckDBTables from '#radial/db/duckdb/createDuckDBTables.js';
import {DuckDBInstance, DuckDBConnection} from '@duckdb/node-api';

class DuckDB {
  disposed: boolean;
  instance: DuckDBInstance | undefined;
  connection: DuckDBConnection | undefined;

  constructor() {
    this.disposed = false;
  }

  [Symbol.dispose]() {
    this.disposed = true;
    if (this.instance) {
      this.instance.closeSync();
    }
  }

  async #createInstance() {
    if (!this.instance) {
      const instance = await DuckDBInstance.create(process.env['DUCK_DB_FILE_NAME']);
      this.instance = instance;
    }

    return this.instance;
  }

  async initialize() {
    await this.#createInstance();
    this.connection = await this.instance?.connect();

    if (!this.connection) {
      throw new Error('Unable to connect to DB.');
    }

    await this.connection.run(createDuckDBTables())
  }
}

export default DuckDB;
