const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const connStr = 'postgresql://postgres.zuhanlspejgizjbwbnda:80676462789voxa@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';

async function run() {
  const client = new Client({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false }
  });
  
  await client.connect();
  console.log('Connected to database via pooler.');

  const migrationsDir = path.join(__dirname, '../supabase/migrations');
  const file = '064_inventory_reserves.sql';
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
