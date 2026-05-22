const dns = require('dns');
const { promisify } = require('util');
const { Client } = require('pg');

const lookup = promisify(dns.lookup);

const regions = [
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-central-2',
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-south-1',
  'sa-east-1',
  'ca-central-1'
];

async function scan() {
  console.log('Scanning Supabase pooler regions...');
  for (const region of regions) {
    const host = `aws-0-${region}.pooler.supabase.com`;
    try {
      const ip = await lookup(host);
      console.log(`Resolved: ${host} -> IP: ${ip.address}`);
      
      // Try to connect to this region
      const connStr = `postgresql://postgres.zuhanlspejgizjbwbnda:80676462789@${host}:6543/postgres`;
      const client = new Client({ connectionString: connStr, connectionTimeoutMillis: 5000 });
      try {
        await client.connect();
        console.log(`=== SUCCESS! Connected to ${region} ===`);
        const res = await client.query('SELECT 1 + 1 AS result');
        console.log('Query result:', res.rows[0]);
        await client.end();
        return; // Stop scanning once found
      } catch (connErr) {
        console.log(`Connection to ${region} failed: ${connErr.message}`);
      }
    } catch (dnsErr) {
      // DNS resolution failed for this region pooler
      // console.log(`DNS failed for ${region}`);
    }
  }
  console.log('Scan completed.');
}

scan();
