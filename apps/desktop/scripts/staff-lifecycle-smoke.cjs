// Compiled Electron/SQLite check. Never opens the shop's data directory or network.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { LocalDatabase } = require('../dist/db/localDatabase.js')
const { LocalStaffRepository } = require('../dist/repositories/staffRepository.js')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forsage-staff-smoke-'))
let db
try {
  db = new LocalDatabase(root)
  let staff = new LocalStaffRepository(db)
  staff.saveServerUser({id:'smoke-employee',phone:'+380671112233',full_name:'Smoke Employee',role:'cashier'}, 'smoke-test-password')
  staff.setPin('smoke-employee','1234')
  assert.equal(staff.loginWithPassword('0671112233','smoke-test-password').id,'smoke-employee')
  staff.saveUserSettings('smoke-employee',{base_rate:10000},[{rule_type:'pos_sales',pct_from_revenue:5,pct_from_profit:0}])
  staff.deleteUser('smoke-employee')
  assert.throws(()=>staff.loginWithPassword('0671112233','smoke-test-password'),/LOCAL_AUTH_ARCHIVED/)
  db.close(); db = new LocalDatabase(root); staff = new LocalStaffRepository(db)
  staff.restoreUser('smoke-employee')
  assert.equal(staff.loginWithPassword('0671112233','smoke-test-password').id,'smoke-employee')
  assert.equal(staff.verifyPin('smoke-employee','1234').valid,true)
  assert.equal(staff.listCommissionRules()[0].pct_from_revenue,5)
  console.log('Compiled staff lifecycle smoke passed: create, login, settings, archive, restart, restore, offline login and PIN')
} finally {
  db?.close()
  const resolved = path.resolve(root)
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('forsage-staff-smoke-')) fs.rmSync(resolved,{recursive:true,force:true})
}
