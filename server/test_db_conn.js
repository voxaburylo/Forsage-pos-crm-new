require('dotenv').config();
const { Client } = require('pg');

const connStr = process.env.DATABASE_URL;

async function main() {
  console.log('Connecting to:', connStr ? connStr.replace(/:[^:@]+@/, ':***@') : 'undefined');
  const client = new Client({ connectionString: connStr });
  try {
    await client.connect();
    console.log('Successfully connected to DB!');
    const res = await client.query('SELECT 1 + 1 AS result');
    console.log('Query result:', res.rows[0]);
  } catch (err) {
    console.error('Connection failed:', err.message);
  } finally {
    await client.end();
  }
}

main();
