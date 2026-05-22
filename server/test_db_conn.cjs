const { Client } = require('pg');

async function test(name, connStr) {
  const client = new Client({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000
  });
  try {
    await client.connect();
    console.log(`[${name}] Successfully connected to DB with SSL!`);
    const res = await client.query('SELECT 1 + 1 AS result');
    console.log(`[${name}] Query result:`, res.rows[0]);
  } catch (err) {
    console.error(`[${name}] Connection failed:`, err.message);
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  const password = '80676462789voxa';
  const ref = 'zuhanlspejgizjbwbnda';
  
  await test('User: postgres.' + ref + ' Port: 6543 SSL', `postgresql://postgres.${ref}:${password}@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`);
  await test('User: postgres.' + ref + ' Port: 5432 SSL', `postgresql://postgres.${ref}:${password}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`);
}

main();
