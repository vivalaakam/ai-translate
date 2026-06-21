import { Model, DataTypes, sql } from '@sequelize/core';
import type { InferAttributes, InferCreationAttributes, CreationOptional } from '@sequelize/core';
import { Attribute, Table } from '@sequelize/core/decorators-legacy';

/**
 * Sequelize model for the `files` table — binary image data (BYTEA).
 *
 * `data` is declared as BLOB; the Postgres dialect returns it as a `Buffer`,
 * matching the previous raw-pg behavior. The id is a deterministic UUID v5
 * derived from keccak256 of the binary content (see generateFileId).
 */
@Table({
  tableName: 'files',
  timestamps: false,
  underscored: true,
})
export class FileModel extends Model<InferAttributes<FileModel>, InferCreationAttributes<FileModel>> {
  @Attribute({ type: DataTypes.TEXT, primaryKey: true, allowNull: false })
  declare id: string;

  @Attribute({ type: DataTypes.TEXT, allowNull: false })
  declare bookId: string;

  @Attribute({ type: DataTypes.TEXT, allowNull: false })
  declare originalPath: string;

  @Attribute({ type: DataTypes.TEXT, allowNull: false, defaultValue: 'application/octet-stream' })
  declare mimeType: CreationOptional<string>;

  @Attribute({ type: DataTypes.BLOB, allowNull: false })
  declare data: Buffer;

  @Attribute({ type: DataTypes.DATE, allowNull: false, defaultValue: sql.fn('now') })
  declare createdAt: CreationOptional<Date>;
}