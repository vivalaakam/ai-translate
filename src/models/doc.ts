import { Model, DataTypes, sql } from '@sequelize/core';
import type { InferAttributes, InferCreationAttributes, CreationOptional } from '@sequelize/core';
import { Attribute, Table } from '@sequelize/core/decorators-legacy';

/**
 * Sequelize model for the `docs` table (a book / uploaded document).
 *
 * Column names are snake_case in the database; `underscored: true` maps the
 * camelCase attribute names below to the correct columns. The primary key `id`
 * is a deterministic UUID v5 (see generateBookId in db/database.ts), supplied
 * by the application — never auto-generated.
 */
@Table({
  tableName: 'docs',
  timestamps: false,
  underscored: true,
})
export class Doc extends Model<InferAttributes<Doc>, InferCreationAttributes<Doc>> {
  @Attribute({ type: DataTypes.TEXT, primaryKey: true, allowNull: false })
  declare id: string;

  @Attribute({ type: DataTypes.TEXT, allowNull: false })
  declare title: string;

  @Attribute({ type: DataTypes.TEXT, allowNull: false, defaultValue: '' })
  declare author: CreationOptional<string>;

  @Attribute({ type: DataTypes.TEXT, allowNull: false, defaultValue: '' })
  declare language: CreationOptional<string>;

  @Attribute({ type: DataTypes.TEXT, allowNull: false, defaultValue: '' })
  declare filename: CreationOptional<string>;

  @Attribute({ type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 })
  declare totalBlocks: CreationOptional<number>;

  @Attribute({ type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 })
  declare translatedBlocks: CreationOptional<number>;

  @Attribute({ type: DataTypes.TEXT, allowNull: true })
  declare targetLang: CreationOptional<string | null>;

  @Attribute({ type: DataTypes.TEXT, allowNull: true })
  declare sourceLang: CreationOptional<string | null>;

  @Attribute({ type: DataTypes.TEXT, allowNull: true })
  declare model: CreationOptional<string | null>;

  @Attribute({ type: DataTypes.TEXT, allowNull: false, defaultValue: 'uploaded' })
  declare status: CreationOptional<string>;

  @Attribute({ type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 })
  declare totalPages: CreationOptional<number>;

  @Attribute({ type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 })
  declare parsedPages: CreationOptional<number>;

  @Attribute({ type: DataTypes.TEXT, allowNull: true })
  declare sourcePath: CreationOptional<string | null>;

  @Attribute({ type: DataTypes.DATE, allowNull: false, defaultValue: sql.fn('now') })
  declare createdAt: CreationOptional<Date>;

  @Attribute({ type: DataTypes.DATE, allowNull: true })
  declare completedAt: CreationOptional<Date | null>;
}