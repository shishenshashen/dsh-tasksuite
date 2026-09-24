/**
 * Deterministic harness for awr-goal-supervisor — verifies the REAL auto-resume
 * call path and the guards around it WITHOUT touching a live DSH process.
 *
 * Mocks ctx (shell/timer/fs/agents/events) and drives the plugin's apply().
 * Checks:
 *   1. dryRun:true never calls agents.resume (even with candidates + unfinished AWR).
 *   2. resume:true + dryRun:false DOES call agents.resume({ resumeSessionId })
 *      for a stale, non-live, recent session when AWR has unfinished work.
 *   3. resume:true + no unfinished AWR work skips resume.
 *   4. A session still live is NOT resumed.
 *   5. sessions that stop producing heartbeats get flagged FAKE-DEATH.
 */
'use strict'
const path = require('path')
const os = require('os')
const fs = require('fs')

const make = require('./index.js')

function runTest(name, cfg, steps, opts) {
  opts = opts || {}
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awr-sup-test-'))
  const ledgerFile = path.join(tmp, 'ledger.json')
  const writes = []
  const resumed = []
  const logged = []
  const events = {}
  const now = () => Date.now()

  // Permanent console capture: interval callbacks may fire after drive() returns,
  // so record from the very start and keep it active for the test's lifetime.
  const origConsole = console.log
  console.log = (...a) => { logged.push(a.join(' ')); origConsole(...a) }

  const live = new Set(opts.live || [])
  let awrStatusOut = opts.awrStatusOut || ''

  // collect mock timers so the test can clean them up and let node exit
  const timers = { ints: [], tos: [] }

  // mock fs service
  const fsSv = {
    resolve(target) { return Promise.resolve({ targetKey: 'k:' + target, displayPath: target }) },
    stat() {
      return fs.existsSync(ledgerFile)
        ? Promise.resolve({ type: 'file', version: 'v1' })
        : Promise.resolve(undefined)
    },
    readText() { return Promise.resolve(fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8') : '') },
    writeText(target, content) {
      writes.push(content)
      fs.writeFileSync(ledgerFile, content, 'utf8')
      return Promise.resolve({ operation: 'update', version: 'v2', before: null, after: content })
    },
  }

  // mock agents service
  const agentsSv = {
    list() { return Array.from(live).map((id) => ({ id })) },
    resume(options) {
      resumed.push(options)
      return Promise.resolve({ agent: { id: options.resumeSessionId }, dispose() { return Promise.resolve() } })
    },
  }

  // mock shell service
  const shellSv = {
    resolve({ command }) { return { command } }, // synchronous, matches ShellExecSpec contract
    run(spec) {
      const command = spec && spec.command || ''
      if (command.includes('status')) {
        return Promise.resolve({ exitCode: 0, stdout: { text: awrStatusOut }, stderr: { text: '' } })
      }
      if (command.includes('recovery')) {
        return Promise.resolve({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } })
      }
      return Promise.resolve({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } })
    },
  }

  const ctxMock = {
    get(name) {
      if (name === 'fs') return fsSv
      if (name === 'agents') return agentsSv
      return undefined
    },
    on(evt, fn) { (events[evt] = events[evt] || []).push(fn) },
    // Deterministic mock timers: fire fast (10ms/30ms) regardless of the real
    // ms argument, so tests do not wait for production intervals (5min scan,
    // 1.5s boot timeout, 30s heartbeat).
    interval(fn) { const h = setInterval(fn, 10); timers.ints.push(h); return () => clearInterval(h) },
    timeout(fn) { const h = setTimeout(fn, 30); timers.tos.push(h); return () => clearTimeout(h) },
  }
  // injected host services
  ctxMock.shell = shellSv
  ctxMock.timer = {}

  const plugin = make(cfg)()
  plugin.apply(ctxMock)

  // drive steps
  async function drive() {
    for (const s of steps) {
      if (s === 'session-start') {
        for (const fn of events['agent/session-start']) await fn({ agent: { id: opts.sid || 'S1' }, source: 'startup' })
      } else if (s === 'pre-step') {
        for (const fn of events['agent/pre-step']) await fn({ agent: { id: 'S1' }, turn: 1, step: 1 }, () => Promise.resolve())
      } else if (s === 'turn-stopping') {
        for (const fn of events['agent/turn-stopping']) await fn({ agent: { id: 'S1' }, turn: 2 })
      } else if (s === 'error') {
        for (const fn of events['agent/error']) await fn({ agent: { id: 'S1' }, turn: 2, step: 2, error: new Error('x') })
      } else if (s === 'wait-resume') {
        await new Promise((r) => setTimeout(r, 80)) // let the boot timeout fire
      } else if (s === 'wait-stale') {
        // advance internal heartbeat age by faking a long 'lastHeartbeat' — we
        // do this by pre-warming the clock: simulate elapsed time.
        await new Promise((r) => setTimeout(r, 400))
      }
    }
  }

  return {
    drive,
    resumed,
    logged,
    writes,
    events,
    cleanup() {
      for (const h of timers.ints) clearInterval(h)
      for (const h of timers.tos) clearTimeout(h)
    },
    get: () => ({ resumed, logged, writes }),
  }
}

async function main() {
  let pass = 0
  let fail = 0
  function check(cond, msg) {
    if (cond) { pass++; console.log('  PASS: ' + msg) }
    else { fail++; console.log('  FAIL: ' + msg) }
  }

  // Test 1: dryRun:true — never resume even with unfinished AWR + stale candidate
  console.log('\n[1] dryRun:true must NOT resume')
  {
    const t = runTest('t1', { dryRun: true, resume: true, workdir: '', ledgerPath: '' }, ['session-start', 'wait-resume'], {
      awrStatusOut: 'continue: 2\nclaimable: 1\nwaiting: 0\n',
    })
    await t.drive()
    check(t.resumed.length === 0, 'no resume calls when dryRun=true (got ' + t.resumed.length + ')')
    t.cleanup()
  }

  // Test 2: resume:true + dryRun:false + unfinished AWR + stale non-live session
  console.log('\n[2] resume:true pulls up a stale non-live session')
  {
    const t = runTest('t2', { dryRun: false, resume: true, resumeWindowMs: 3600000, workdir: '', ledgerPath: '' }, ['session-start', 'wait-resume'], {
      awrStatusOut: 'Continue: 1 | Claimable: 0 | Waiting: 0 | Blocked: 0\n',
      live: [],
    })
    await t.drive()
    const hasResume = t.resumed.some((r) => r.resumeSessionId === 'S1')
    check(hasResume, 'agents.resume({resumeSessionId:"S1"}) called for stale session')
    t.cleanup()
  }

  // Test 3: resume:true but NO unfinished AWR work → skip
  console.log('\n[3] no unfinished AWR work → skip resume')
  {
    const t = runTest('t3', { dryRun: false, resume: true, resumeWindowMs: 3600000, workdir: '', ledgerPath: '' }, ['session-start', 'wait-resume'], {
      awrStatusOut: 'Continue: 0 | Claimable: 0 | Waiting: 0 | Blocked: 0\n',
      live: [],
    })
    await t.drive()
    check(t.resumed.length === 0, 'no resume when AWR has no unfinished work')
    t.cleanup()
  }

  // Test 4: session still live → NOT resumed
  console.log('\n[4] still-live session is NOT resumed')
  {
    const t = runTest('t4', { dryRun: false, resume: true, resumeWindowMs: 3600000, workdir: '', ledgerPath: '' }, ['session-start', 'wait-resume'], {
      awrStatusOut: 'Continue: 1 | Claimable: 0 | Waiting: 0 | Blocked: 0\n',
      live: ['S1'],
    })
    await t.drive()
    check(t.resumed.length === 0, 'live session S1 not resumed')
    t.cleanup()
  }

  // Test 5: stale detection — heartbeat age exceeds stalenessMs
  console.log('\n[5] fake-death flagged on stale heartbeat')
  {
    const t = runTest('t5', { dryRun: true, resume: false, stalenessMs: 50, heartbeatMs: 20, workdir: '', ledgerPath: '' }, ['session-start', 'wait-stale'], {
      awrStatusOut: '',
    })
    await t.drive()
    const flagged = t.logged.some((l) => l.includes('FAKE-DEATH'))
    check(flagged, 'FAKE-DEATH logged when no heartbeat for > stalenessMs')
    t.cleanup()
  }

  // Test 6: periodic re-scan — a session that died while the process kept
  // running (e.g. LLM retry exhaustion) is pulled up without a restart.
  console.log('\n[6] periodic re-scan pulls up a session that died in-run')
  {
    // boot scan (during first wait-resume) sees an EMPTY ledger → no candidates.
    // Then session-start records S1 into the ledger; S1 is not live anymore
    // (like a terminated conversation). The periodic scan (mock interval fires
    // every ~10ms, well inside the 80ms wait) must then resume S1.
    const t = runTest('t6', { dryRun: false, resume: true, resumeWindowMs: 3600000, resumeScanMs: 10, workdir: '', ledgerPath: '' }, ['wait-resume', 'session-start', 'wait-resume'], {
      awrStatusOut: 'Continue: 1 | Claimable: 0 | Waiting: 0 | Blocked: 0\n',
      live: [],
    })
    await t.drive()
    const hasResume = t.resumed.some((r) => r.resumeSessionId === 'S1')
    check(hasResume, 'periodic scan resumed S1 after it was recorded then died')
    const periodicLogged = t.logged.some((l) => l.includes('auto-resume scan (periodic)'))
    check(periodicLogged, 'periodic scan actually ran (log line present)')
    t.cleanup()
  }

  console.log('\n=== RESULTS: ' + pass + ' passed, ' + fail + ' failed ===')
  if (fail > 0) process.exit(1)
  console.log('ALL CHECKS PASSED')
}

main().catch((e) => { console.error(e); process.exit(1) })
