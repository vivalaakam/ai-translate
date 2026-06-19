import type { Sequelize } from '@sequelize/core';
import type { MigrationFn } from 'umzug';

export interface MigrationContext {
  sequelize: Sequelize;
}

/**
 * Initial schema — creates docs / files / blocks / tasks with the exact DDL
 * the previous procedural `migrate()` used.
 *
 * The DDL is idempotent (`IF NOT EXISTS`) so this migration is safe to run
 * against an existing `ai_translate` database that already has these tables
 * from the old `TranslateDb.migrate()` — it will simply no-op and be recorded
 * as applied in `schema_migrations`.
 */
export const up: MigrationFn<MigrationContext> = async ({ context }) => {
  const { sequelize } = context;

  // Rename the legacy `books` table → `docs` (for databases predating the rename).
  await sequelize.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'books') THEN
        ALTER TABLE books RENAME TO docs;
      END IF;
    END $$;
  `);

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS docs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT '',
      filename TEXT NOT NULL DEFAULT '',
      total_blocks INTEGER NOT NULL DEFAULT 0,
      translated_blocks INTEGER NOT NULL DEFAULT 0,
      target_lang TEXT,
      source_lang TEXT,
      model TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      original_path TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (book_id) REFERENCES docs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS blocks (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      block_index INTEGER NOT NULL,
      doc_path TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      lang TEXT NOT NULL,
      model TEXT,
      source_id TEXT,
      file_id TEXT,
      tag_name TEXT NOT NULL DEFAULT 'p',
      attributes TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (book_id) REFERENCES docs(id) ON DELETE CASCADE,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'ocr_page',
      page_num INTEGER,
      total_pages INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      content TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_blocks_book_id ON blocks(book_id);
    CREATE INDEX IF NOT EXISTS idx_blocks_book_doc ON blocks(book_id, doc_path);
    CREATE INDEX IF NOT EXISTS idx_blocks_book_index ON blocks(book_id, block_index);
    CREATE INDEX IF NOT EXISTS idx_blocks_file_id ON blocks(file_id);
    CREATE INDEX IF NOT EXISTS idx_blocks_source_id ON blocks(source_id);
    CREATE INDEX IF NOT EXISTS idx_blocks_lang ON blocks(book_id, lang);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_translation_unique ON blocks(source_id, lang, model) WHERE source_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_files_book_id ON files(book_id);
    CREATE INDEX IF NOT EXISTS idx_files_original_path ON files(book_id, original_path);
    CREATE INDEX IF NOT EXISTS idx_tasks_doc_id ON tasks(doc_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_doc_status ON tasks(doc_id, status);
  `);

  // Columns added to docs after the initial release (idempotent).
  await sequelize.query(`
    ALTER TABLE docs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'uploaded';
    ALTER TABLE docs ADD COLUMN IF NOT EXISTS total_pages INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE docs ADD COLUMN IF NOT EXISTS parsed_pages INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE docs ADD COLUMN IF NOT EXISTS source_path TEXT;
  `);
};

export const down: MigrationFn<MigrationContext> = async ({ context }) => {
  const { sequelize } = context;
  // Drop in reverse FK dependency order.
  await sequelize.query('DROP TABLE IF EXISTS tasks');
  await sequelize.query('DROP TABLE IF EXISTS blocks');
  await sequelize.query('DROP TABLE IF EXISTS files');
  await sequelize.query('DROP TABLE IF EXISTS docs');
};