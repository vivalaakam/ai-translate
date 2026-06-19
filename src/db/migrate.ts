import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Umzug } from 'umzug';
import type { RunnableMigration, MigrationFn } from 'umzug';
import type { Sequelize } from '@sequelize/core';
import { getSequelize, closeSequelize } from '../models/index.js';
import { SchemaMigrationsStorage } from './migration-storage.js';

export type MigrationContext = { sequelize: Sequelize };

/**
 * Discover migration files in src/migrations (or dist/migrations when compiled)
 * relative to this module, and load each as an ESM module. Works under tsx
 * (`.ts` files) and under plain node (compiled `.js` files).
 */
async function loadMigrations(dir: string): Promise<RunnableMigration<MigrationContext>[]> {
  const files = readdirSync(dir)
    .filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts'))
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const fullPath = join(dir, file);
      const mod = await import(pathToFileURL(fullPath).href);
      return {
        name: file.replace(/\.(ts|js)$/, ''),
        path: fullPath,
        up: mod.up as MigrationFn<MigrationContext>,
        down: mod.down as MigrationFn<MigrationContext>,
      };
    }),
  );
}

/**
 * Run all pending database migrations. Idempotent — safe to call on every
 * startup (used by `TranslateDb.migrate()` and the `npm run db:migrate` script).
 */
export async function runMigrations(connectionString?: string): Promise<void> {
  const sequelize = getSequelize(connectionString);
  const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
  const migrations = await loadMigrations(migrationsDir);

  const umzug = new Umzug<MigrationContext>({
    storage: new SchemaMigrationsStorage(sequelize),
    context: { sequelize },
    migrations,
    logger: console,
  });

  await umzug.up();
}

// CLI entry point: `npm run db:migrate` (tsx src/db/migrate.ts)
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  runMigrations()
    .then(async () => {
      console.log('Migrations complete.');
      await closeSequelize();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Migration failed:', err);
      await closeSequelize();
      process.exit(1);
    });
}