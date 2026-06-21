import { Model, DataTypes, sql } from '@sequelize/core';
import type { InferAttributes, InferCreationAttributes, CreationOptional } from '@sequelize/core';
import { Attribute, Table } from '@sequelize/core/decorators-legacy';

/**
 * Sequelize model for the `blocks` table.
 *
 * The blocks table stores BOTH originals and translations in one table:
 *   - Original:    lang = source language, model = NULL, sourceId = NULL
 *   - Translation: lang = target language, model = model name, sourceId = original block id
 *
 * `index` maps to the `block_index` column (explicit columnName, since
 * `underscored` would otherwise leave the single-word name unchanged).
 */
@Table({
  tableName: 'blocks',
  timestamps: false,
  underscored: true,
})
export class Block extends Model<InferAttributes<Block>, InferCreationAttributes<Block>> {
  @Attribute({ type: DataTypes.TEXT, primaryKey: true, allowNull: false })
  declare id: string;

  @Attribute({ type: DataTypes.TEXT, allowNull: false })
  declare bookId: string;

  @Attribute({ type: DataTypes.INTEGER, allowNull: false, columnName: 'block_index' })
  declare index: number;

  @Attribute({ type: DataTypes.TEXT, allowNull: false })
  declare docPath: string;

  @Attribute({ type: DataTypes.TEXT, allowNull: false })
  declare type: string;

  @Attribute({ type: DataTypes.TEXT, allowNull: false, defaultValue: '' })
  declare content: CreationOptional<string>;

  @Attribute({ type: DataTypes.TEXT, allowNull: false })
  declare lang: string;

  @Attribute({ type: DataTypes.TEXT, allowNull: true })
  declare model: CreationOptional<string | null>;

  @Attribute({ type: DataTypes.TEXT, allowNull: true })
  declare sourceId: CreationOptional<string | null>;

  @Attribute({ type: DataTypes.TEXT, allowNull: true })
  declare fileId: CreationOptional<string | null>;

  @Attribute({ type: DataTypes.TEXT, allowNull: false, defaultValue: 'p' })
  declare tagName: CreationOptional<string>;

  @Attribute({ type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' })
  declare attributes: CreationOptional<string>;

  @Attribute({ type: DataTypes.DATE, allowNull: false, defaultValue: sql.fn('now') })
  declare createdAt: CreationOptional<Date>;
}