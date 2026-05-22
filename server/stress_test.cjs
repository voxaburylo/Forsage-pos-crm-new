const { Client } = require('pg');

const connStr = 'postgresql://postgres.zuhanlspejgizjbwbnda:80676462789voxa@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';

async function runTest() {
  const client = new Client({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  console.log('Connected to DB.');

  const tenantId = '00000000-0000-0000-0000-000000000001';
  const employeeId = '00000000-0000-0000-0000-000000000002';
  const employeeName = 'Test Employee';
  const createdBy = '00000000-0000-0000-0000-000000000002';
  const sku = 'TEST-RACE-' + Date.now();

  try {
    // 1. Ensure allow_negative_qty = false in shop_settings
    console.log('Setting allow_negative_qty = false in shop_settings...');
    await client.query(
      `INSERT INTO shop_settings (tenant_id, shop_name, allow_negative_qty)
       VALUES ($1, 'Test Shop', false)
       ON CONFLICT (tenant_id) DO UPDATE SET allow_negative_qty = false`,
      [tenantId]
    );

    // 2. Create a test product with qty_on_hand = 5
    console.log('Creating test product...');
    const prodRes = await client.query(
      `INSERT INTO products (tenant_id, sku, name, retail_price, purchase_price, qty_on_hand, unit)
       VALUES ($1, $2, 'Test Race Product', 1000, 500, 5, 'шт')
       RETURNING id`,
      [tenantId, sku]
    );
    const productId = prodRes.rows[0].id;
    console.log(`Product created with ID: ${productId}, initial qty: 5`);

    // 3. Prepare 10 concurrent requests to decrement stock by 1
    const items = JSON.stringify([{ product_id: productId, qty: 1, buy_price: 500 }]);
    console.log('Launching 10 concurrent process_internal_consumption requests...');

    const promises = [];
    for (let i = 0; i < 10; i++) {
      const workerClient = new Client({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
      promises.push((async (index) => {
        await workerClient.connect();
        try {
          const res = await workerClient.query(
            `SELECT process_internal_consumption($1, $2, $3, $4::jsonb, 500, 'Test Note', $5) AS result`,
            [tenantId, employeeId, employeeName, items, createdBy]
          );
          await workerClient.end();
          return { index, success: true, data: res.rows[0].result };
        } catch (err) {
          await workerClient.end();
          return { index, success: false, error: err.message };
        }
      })(i));
    }

    const results = await Promise.all(promises);

    let successes = 0;
    let failures = 0;
    let insufficientStockErrors = 0;

    results.forEach(r => {
      if (r.success) {
        successes++;
        console.log(`Request #${r.index}: SUCCESS`);
      } else {
        failures++;
        console.log(`Request #${r.index}: FAILED - ${r.error}`);
        if (r.error.includes('INSUFFICIENT_STOCK')) {
          insufficientStockErrors++;
        }
      }
    });

    // 4. Check final stock level
    const finalRes = await client.query('SELECT qty_on_hand FROM products WHERE id = $1', [productId]);
    const finalQty = parseFloat(finalRes.rows[0].qty_on_hand);

    console.log('\n--- TEST RESULTS ---');
    console.log(`Total Requests: 10`);
    console.log(`Successes: ${successes} (Expected: 5)`);
    console.log(`Failures: ${failures} (Expected: 5)`);
    console.log(`Failures with INSUFFICIENT_STOCK: ${insufficientStockErrors} (Expected: 5)`);
    console.log(`Final Qty on Hand: ${finalQty} (Expected: 0)`);
    console.log('--------------------\n');

    // 5. Cleanup test data
    console.log('Cleaning up test data...');
    await client.query('DELETE FROM internal_consumptions WHERE items @> $1::jsonb', [JSON.stringify([{ product_id: productId }])]);
    await client.query('DELETE FROM products WHERE id = $1', [productId]);
    console.log('Cleanup completed.');

    if (successes === 5 && failures === 5 && finalQty === 0) {
      console.log('TEST PASSED SUCCESSFULLY!');
      process.exit(0);
    } else {
      console.error('TEST FAILED: Metrics did not match expected values.');
      process.exit(1);
    }

  } catch (err) {
    console.error('Test execution failed:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runTest();
