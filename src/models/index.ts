import { Sequelize } from '@sequelize/core';
import { PostgresDialect } from '@sequelize/postgres';
import { DATABASE_URL } from '../utils/constants.js';
import { Doc } from './doc.js';
import { Block } from './block.js';
import { FileModel } from './file.js';
import { Task } from './task.js';

export { Doc } from './doc.js';
export { Block } from './block.js';
export { FileModel } from './file.js';
export { Task } from './task.js';

/**
 * Module-level singleton Sequelize instance.
 *
 * Mirrors the previous shared `pg.Pool` singleton: every `TranslateDb`
 * instance uses the same connection pool. Recreated after `closeSequelize()`.
 */
let _sequelize: Sequelize | null = null;

export function getSequelize(connectionString?: string): Sequelize {
  if (!_sequelize) {
    _sequelize = new Sequelize({
      dialect: PostgresDialect,
      url: connectionString || process.env.DATABASE_URL || DATABASE_URL,
      pool: { max: 10 },
      define: { underscored: true, timestamps: false },
      logging: false,
      models: [Doc, Block, FileModel, Task],
    });
  }
  return _sequelize;
}

export async function closeSequelize(): Promise<void> {
  if (_sequelize) {
    await _sequelize.close();
    _sequelize = null;
  }
}