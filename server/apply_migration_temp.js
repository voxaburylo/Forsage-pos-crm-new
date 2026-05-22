import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set in server/.env');
  process.exit(1);
}

const client = new pg.Client({ connectionString });

async function run() {
  await client.connect();
  console.log('Connected to database.');

  const migrationsDir = './../supabase/migrations';
  const file = '065_wms_picking.sql';
  const filePath = path.join(migrationsDir, file);

  if (!fs.existsSync(filePath)) {
    console.error(`Migration file not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`Running migration: ${file}...`);
  const sql = fs.readFileSync(filePath, 'utf8');
  try {
    await client.query(sql);
    console.log(`Migration ${file} applied successfully.`);
  } catch (err) {
    console.error(`Error running migration ${file}:`, err.message);
  }

  await client.end();
}

run().catch(err => {
  console.error('Migration runner failed:', err);
  process.exit(1);
});
