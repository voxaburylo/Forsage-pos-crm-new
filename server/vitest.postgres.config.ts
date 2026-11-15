import { defineConfig } from 'vitest/config'

// Never inherit DATABASE_URL or load a production .env for destructive fixtures.
const input = process.env.FORSAGE_TEST_POSTGRES_URL
if (!input) throw new Error('FORSAGE_TEST_POSTGRES_URL must name an isolated local test database')
const url = new URL(input)
if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:'
  || url.search !== '' || url.hash !== ''
  || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)
  || !/^\/forsage_concurrency_test(?:_[a-z0-9_]+)?$/.test(url.pathname)) {
  throw new Error('PostgreSQL concurrency tests only accept a local forsage_concurrency_test database')
}
url.searchParams.set('application_name','forsage-concurrency-test')
url.searchParams.set('options','-c statement_timeout=8000 -c lock_timeout=5000')
export default defineConfig({
  test: {
    environment: 'node', pool: 'forks', maxWorkers: 1,
    include: ['tests/postgres/**/*.test.ts'], testTimeout: 15000, hookTimeout: 30000,
    env: { DATABASE_URL: url.toString(), PG_POOL_MAX: '10' },
  },
})
