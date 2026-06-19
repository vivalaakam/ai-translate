import { QueryTypes } from '@sequelize/core';
import type { Sequelize } from '@sequelize/core';
import type { UmzugStorage, MigrationParams } from 'umzug';

/**
 * Umzug storage backed by a `schema_migrations` table via `sequelize.query`.
 *
 * Built custom (instead of umzug's `SequelizeStorage`) because `SequelizeStorage`
 * targets the Sequelize v6 API (`sequelize.define`/`isDefined`/`model`) which
 * Sequelize 7 no longer provides. This needs only `sequelize.query` and stores
 * applied-migration names in the database — the conventional, shareable
 * approach for a Postgres-backed app.
 */
export class SchemaMigrationsStorage implements UmzugStorage<unknown> {
  private readonly sequelize: Sequelize;

  constructor(sequelize: Sequelize) {
    this.sequelize = sequelize;
  }

  private async ensureTable(): Promise<void> {
    await this.sequelize.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async logMigration({ name }: MigrationParams<unknown>): Promise<void> {
    await this.ensureTable();
    await this.sequelize.query(
      'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
      { bind: [name] },
    );
  }

  async unlogMigration({ name }: MigrationParams<unknown>): Promise<void> {
    await this.ensureTable();
    await this.sequelize.query('DELETE FROM schema_migrations WHERE name = $1', { bind: [name] });
  }

  async executed(): Promise<string[]> {
    await this.ensureTable();
    const rows = await this.sequelize.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name ASC',
      { type: QueryTypes.SELECT },
    );
    return rows.map((r) => r.name);
  }
}