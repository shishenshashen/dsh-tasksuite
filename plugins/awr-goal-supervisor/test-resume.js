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
  // Pre-seed the ledger so tests can bind a session to a workId up front
  // (Gap A) or backdate lastSeen to simulate fake-death (Gap B).
  if (opts.ledgerSeed) {
    fs.writeFileSync(ledgerFile, JSON.stringify(opts.ledgerSeed), 'utf8')
    // ledgerSeed requires the plugin to actually read the file: with an empty
    // ledgerPath ledgerLoad() short-circuits to an in-memory empty ledger.
    cfg = Object.assign({}, cfg, { ledgerPath: ledgerFile })
  }
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
      if (opts.resumeFail === 'already-owned') {
        return Promise.reject(new Error('session "' + options.resumeSessionId + '" is already owned by an active write handle'))
      }
      return Promise.resolve({ agent: { id: options.resumeSessionId }, dispose() { return Promise.resolve() } })
    },
  }

  // mock agentPresets service — records preset mounts so tests can verify the
  // supervisor re-attaches the session's own preset on pull-up.
  const mountedPresets = []
  const presetsSv = {
    mount(agentCtx, id) {
      mountedPresets.push(id || '(default)')
      return Promise.resolve({ id: id || 'default' })
    },
  }

  // mock shell service
  const shellSv = {
    resolve({ command }) { return { command } }, // synchronous, matches ShellExecSpec contract
    run(spec) {
      const command = spec && spec.command || ''
      if (command.includes('work') && command.includes('show')) {
        const out = opts.workShowOut || 'Status: in_progress; ready: true\n'
        return Promise.resolve({ exitCode: 0, stdout: { text: out }, stderr: { text: '' } })
      }
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
      if (name === 'agentPresets') return presetsSv
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
    mountedPresets,
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

  // Test 7 (Gap A): session bound to a workId whose AWR status is terminal
  // (completed/cancelled) must NOT be resumed.
  console.log('\n[7] workId bound to completed work → skip resume')
  {
    const t = runTest('t7', { dryRun: false, resume: true, resumeWindowMs: 3600000, workdir: '', ledgerPath: '' }, ['wait-resume'], {
      awrStatusOut: 'Continue: 1 | Claimable: 0 | Waiting: 0 | Blocked: 0\n',
      workShowOut: 'W1 — some done task\nStatus: completed; ready: false\n',
      ledgerSeed: { version: 1, sessions: { S1: { lastSeen: Date.now(), workId: 'W1' } } },
      live: [],
    })
    await t.drive()
    check(t.resumed.length === 0, 'no resume when bound work is terminal')
    const skipped = t.logged.some((l) => l.includes('is completed/cancelled (terminal)'))
    check(skipped, 'skip logged with terminal-work reason')
    t.cleanup()
  }

  // Test 8 (Gap A): session bound to a workId whose AWR status is in_progress
  // (non-terminal) IS resumed.
  console.log('\n[8] workId bound to in_progress work → resume')
  {
    const t = runTest('t8', { dryRun: false, resume: true, resumeWindowMs: 3600000, workdir: '', ledgerPath: '' }, ['wait-resume'], {
      awrStatusOut: 'Continue: 1 | Claimable: 0 | Waiting: 0 | Blocked: 0\n',
      workShowOut: 'W1 — an active task\nStatus: in_progress; ready: false\n',
      ledgerSeed: { version: 1, sessions: { S1: { lastSeen: Date.now(), workId: 'W1' } } },
      live: [],
    })
    await t.drive()
    const hasResume = t.resumed.some((r) => r.resumeSessionId === 'S1')
    check(hasResume, 'resume called for non-terminal bound work')
    t.cleanup()
  }

  // Test 9 (Gap B): a session STILL in the live registry but with lastSeen
  // older than liveStaleMs is fake-dead and must be pulled up.
  console.log('\n[9] live but stale (fake-dead) session → resume')
  {
    const stale = Date.now() - 20 * 60 * 1000 // 20min ago: > liveStaleMs(10min), < resumeWindowMs(1h)
    const t = runTest('t9', { dryRun: false, resume: true, resumeWindowMs: 3600000, liveStaleMs: 600000, workdir: '', ledgerPath: '' }, ['wait-resume'], {
      awrStatusOut: 'Continue: 1 | Claimable: 0 | Waiting: 0 | Blocked: 0\n',
      ledgerSeed: { version: 1, sessions: { S1: { lastSeen: stale } } },
      live: ['S1'],
    })
    await t.drive()
    const hasResume = t.resumed.some((r) => r.resumeSessionId === 'S1')
    check(hasResume, 'live-but-fake-dead session S1 resumed')
    t.cleanup()
  }

  // Test 10 (Gap C): an agent/error triggers an immediate resume attempt
  // instead of waiting for the next periodic scan.
  console.log('\n[10] error event triggers immediate resume')
  {
    const t = runTest('t10', { dryRun: false, resume: true, errorResumeCooldownMs: 60000, workdir: '', ledgerPath: '' }, ['error', 'wait-resume'], {
      awrStatusOut: 'Continue: 1 | Claimable: 0 | Waiting: 0 | Blocked: 0\n',
      live: [],
    })
    await t.drive()
    const hasResume = t.resumed.some((r) => r.resumeSessionId === 'S1')
    check(hasResume, 'resume called right after agent/error')
    const errScan = t.logged.some((l) => l.includes('auto-resume scan (error-triggered)'))
    check(errScan, 'error-triggered scan logged')
    t.cleanup()
  }

  // Test 11: pull-up must re-attach the session's own agent preset so the
  // resumed session keeps its full tool table (bash/fs/jobs/goal), mirroring
  // the GUI resume path (api-session-controller composeAgent → presets.mount).
  console.log('\n[11] resume carries preset setup that mounts the session preset')
  {
    const t = runTest('t11', { dryRun: false, resume: true, resumeWindowMs: 3600000, workdir: '', ledgerPath: '' }, ['wait-resume'], {
      awrStatusOut: 'Continue: 1 | Claimable: 0 | Waiting: 0 | Blocked: 0\n',
      ledgerSeed: { version: 1, sessions: { S1: { lastSeen: Date.now(), preset: 'soul' } } },
      live: [],
    })
    await t.drive()
    const call = t.resumed.find((r) => r.resumeSessionId === 'S1')
    check(!!call, 'agents.resume called for stale session')
    if (call && typeof call.setup === 'function') {
      // Invoke the setup callback the plugin attached, exactly as agent-loop
      // would with (agentCtx, agent), and verify the preset got mounted.
      await call.setup({}, { id: 'S1' })
      check(t.mountedPresets.includes('soul'), 'preset "soul" mounted via resume setup (got ' + JSON.stringify(t.mountedPresets) + ')')
    } else {
      check(false, 'resume options carried a setup callback (none found)')
    }
    const logOk = t.logged.some((l) => l.includes('preset mounted for S1: soul'))
    check(logOk, 'preset-mounted log line present')
    t.cleanup()
  }

  // Test 12: already-owned failures (the session is actually alive / its write
  // handle is held) must back off that session so periodic scans stop
  // hammering the same six sessions every 5 minutes.
  console.log('\n[12] already-owned resume failure enters cooldown (no per-scan retry)')
  {
    const t = runTest('t12', { dryRun: false, resume: true, resumeWindowMs: 3600000, resumeScanMs: 10, resumeFailCooldownMs: 600000, workdir: '', ledgerPath: '' }, ['wait-resume', 'wait-resume'], {
      awrStatusOut: 'Continue: 1 | Claimable: 0 | Waiting: 0 | Blocked: 0\n',
      ledgerSeed: { version: 1, sessions: { S1: { lastSeen: Date.now() } } },
      live: [],
      resumeFail: 'already-owned',
    })
    await t.drive()
    const attempts = t.resumed.filter((r) => r.resumeSessionId === 'S1').length
    check(attempts === 1, 'only ONE resume attempt despite two scans (cooldown active; got ' + attempts + ')')
    const cooled = t.logged.some((l) => l.includes('already owned by an active write handle (cooldown'))
    check(cooled, 'already-owned cooldown log line present')
    t.cleanup()
  }

  console.log('\n=== RESULTS: ' + pass + ' passed, ' + fail + ' failed ===')
  if (fail > 0) process.exit(1)
  console.log('ALL CHECKS PASSED')
}

main().catch((e) => { console.error(e); process.exit(1) })
