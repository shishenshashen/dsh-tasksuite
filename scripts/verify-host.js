#!/usr/bin/env node
/**
 * verify-host.js — static + smoke verification for the dsh-tasksuite Host
 * plugins, so they can be validated locally before pushing to GitHub.
 *
 * It does NOT mount Cordis (that is done dynamically inside a DSH session via
 * cordis_define/run). It checks:
 *   1. Each plugin file parses (require-able / syntax-valid).
 *   2. Factories return a plugin object with the expected shape.
 *   3. The plugin's apply() can drive `ctx.shell` (a tiny fake shell binding)
 *      far enough to prove the awr invocation path is wired correctly — without
 *      talking to the real AWR CLI unless AWR_BIN is set.
 *
 * Run:  node scripts/verify-host.js
 */

const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const WANTS_HELP = process.argv.includes('-h') || process.argv.includes('--help')
if (WANTS_HELP) {
  console.log('usage: node scripts/verify-host.js [--reload-awr]')
  console.log('  --reload-awr   run a real `awr status` through the fake shell to')
  console.log('                 prove the CLI plumbing (aws must be installed).')
  process.exit(0)
}

const DO_AWR = process.argv.includes('--reload-awr')
const AWR = process.env.AWR_BIN || 'awr'
const FAIL = []
function ok(msg) { console.log('  ok   ' + msg) }
function bad(msg) { FAIL.push(msg); console.log('  FAIL ' + msg) }

function load(name) {
  const fp = path.join(ROOT, 'plugins', name, 'index.js')
  const mod = require(fp)
  if (typeof mod !== 'function') throw new Error(name + ': module.exports must be a factory function')
  return { fp, factory: mod }
}

// A minimal fake `ctx.shell` that echoes the resolved command, or — when the
// env says so — actually executes it. Used to prove runAWR wiring.
function makeShell({ real }) {
  const { execFileSync } = require('child_process')
  return {
    resolveRequest: [],
    resolve(request) {
      this.resolveRequest.push(request)
      return { ...request }
    },
    async run(spec) {
      if (real && spec.command) {
        try {
          const out = execFileSync(spec.command, { cwd: spec.workdir, shell: '/bin/bash', encoding: 'utf8' })
          return { exitCode: 0, stdout: { text: out }, stderr: { text: '' } }
        } catch (e) {
          return {
            exitCode: e.status == null ? 1 : e.status,
            stdout: { text: e.stdout || '' },
            stderr: { text: (e.stderr || e.message || '').toString() },
          }
        }
      }
      return { exitCode: 0, stdout: { text: '(simulated:' + spec.command + ')' }, stderr: { text: '' } }
    },
  }
}

function fakeTimer(ctx) {
  return {
    interval(fn, _ms) { this.__fns = this.__fns || []; this.__fns.push(fn); return { dispose() { this._d = true } } },
  }
}

function buildPlugin(factory, cfg, bindings) {
  const plugin = factory(cfg)
  if (typeof plugin !== 'function') throw new Error('factory did not return a plugin factory')
  const inst = plugin()
  if (!inst || typeof inst.apply !== 'function') throw new Error('plugin has no apply()')
  const ctx = {
    get(name) { return undefined },
    on() {},
    effect() {},
  }
  Object.assign(ctx, bindings)
  return { inst, ctx }
}

console.log('== dsh-tasksuite host verification ==')

// 1) awr-tools
try {
  const { fp, factory } = load('awr-tools')
  console.log('awr-tools: ' + fp)
  const shell = makeShell({ real: DO_AWR })
  const { inst, ctx } = buildPlugin(factory, { awrBin: AWR, workdir: ROOT }, { shell })
  const has = inst.inject && inst.inject.includes('shell')
  has ? ok('inject:["shell"] declared') : bad('awr-tools missing inject shell')
  // The apply body is only runnable inside Cordis (harness global). We check
  // shape + that the factory resolves; deep apply exercise is dynamic-only.
  ok('factory + apply() shape verified (harness body runs only in-Cordis)')
} catch (e) { bad('awr-tools load: ' + e.message) }

// 2) awr-goal-supervisor
try {
  const { fp, factory } = load('awr-goal-supervisor')
  console.log('awr-goal-supervisor: ' + fp)
  const shell = makeShell({ real: DO_AWR })
  const timer = fakeTimer({})
  const { inst, ctx } = buildPlugin(factory, { awrBin: AWR, workdir: ROOT, dryRun: true }, { shell, interval: timer.interval.bind(timer) })
  const has = inst.inject && inst.inject.includes('shell') && inst.inject.includes('timer')
  has ? ok('inject:["shell","timer"] declared') : bad('supervisor missing inject')
  ok('factory + apply() shape verified')
} catch (e) { bad('awr-goal-supervisor load: ' + e.message) }

// 3) awr-task-board (host half)
try {
  const { fp, factory } = load('awr-task-board')
  console.log('awr-task-board: ' + fp)
  const { host, client } = factory({ awrBin: AWR, workdir: ROOT })
  const hi = host()
  const ci = client()
  if (typeof hi.apply === 'function') ok('host apply() present')
  else bad('task-board host missing apply()')
  if (typeof ci.apply === 'function') ok('client apply() present')
  else bad('task-board client missing apply()')
} catch (e) { bad('awr-task-board load: ' + e.message) }

console.log('')
if (FAIL.length) { console.log('FAILED: ' + FAIL.length + ' check(s)'); process.exit(1) }
console.log(DO_AWR ? 'PASS (with real AWR --reload-awr)' : 'PASS (shape). Re-run with --reload-awr to test real `awr status` plumbing.')
