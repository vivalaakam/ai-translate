import 'dotenv/config';
import { TranslateDb } from './src/db/database.js';

async function main() {
  const db = new TranslateDb();
  await db.migrate();
  console.log('Migration OK');
  await db.close();
  await TranslateDb.closePool();
}

main().catch(console.error);