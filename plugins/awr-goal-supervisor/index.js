/**
 * dsh-tasksuite / plugins/awr-goal-supervisor (HOST)
 *
 * The outer scheduling loop that closes the "cross-restart auto-resume" and
 * "zombie / fake-death (假死) recovery" gaps that no off-the-shelf DSH /
 * Claude Code / MCP piece covers.
 *
 * Two failure shapes we must handle:
 *   A) PROCESS DEATH + RESTART  — the DSH process dies; a fresh root agent is
 *      relaunched (cron/systemd -> dsh-headless). The active goal is disarmed
 *      and never resurrects itself.
 *   B) ZOMBIE / FAKE-DEATH (假死) — the process is still alive but the agent
 *      stops making progress (a hanging model call, a wedged turn, a future
 *      step that never resolves). No tool is running, yet nothing advances.
 *
 * Design (docs/compat-research.md, docs/combined-solution.md)
 * -----------------------------------------------------------
 * - State lives OUTSIDE the process: unfinished-work truth is in the AWR
 *   ledger (work item status, session ownership), and this plugin keeps only a
 *   small durable SESSION LEDGER (file of { sessionId -> lastSeen }) that
 *   survives process restarts so it knows which sessions were active before a
 *   reboot. Both are leaf data; this plugin stores no live objects across
 *   restart.
 * - It is a supervisor / recovery-driver, not a doer: it never carries a goal
 *   forward itself. On restart it (a) reconciles against AWR so the next boot
 *   knows what to resume, and (b) because resume is available (dsh-session-
 *   persistence-jsonl is mounted), it ACTUALLY calls ctx.agents.resume(...) on
 *   sessions that were active before the reboot and are no longer live, closing
 *   BOTH the "process died leaving unfinished work" gap and the "session never
 *   came back" gap.
 *
 * Fake-death detection
 * --------------------
 * The private watchdog can only observe boundaries the loop actually reaches:
 * `agent/pre-step` (every step start) and `agent/turn-stopping` (every safe
 * boundary) refresh the heartbeat. A per-Fiber timer then checks staleness: if
 * `now - lastHeartbeat > stalenessMs`, the run is declared STALE. That is the
 * signal that a model turn is wedged or the loop stalled without any step.
 * On restart, reconcile() reads the ledger + calls resume. True watchdog
 * ENFORCEMENT (killing a wedged in-flight turn) is deliberately left to the OS
 * layer (cron/systemd TimeoutStopSec) — see README — because DSH has no
 * sanctioned way to kill an in-flight turn from inside itself.
 *
 * Verified Host Event + Service contracts used (see docs/):
 *   agent/session-start (emit)   { agent: { id: SessionId }, source }
 *   agent/pre-step      (waterfall { agent, messages, turn, step, signal }, next)
 *   agent/turn-stopping (serial) { agent, turn, signal }
 *   agent/error         (emit)   { agent, turn, step, error }
 *   ctx.shell           resolve()/run() -> ShellRunResult
 *   ctx.timer           timeout()/interval()/debounce()
 *   ctx.fs (optional)   resolve/readText/stat/writeText (session ledger)
 *   ctx.agents (opt.)   list() -> Agent[]; resume({resumeSessionId}) -> AgentHandle
 *
 * All contributions attach to the current Fiber (ctx.on / disposers) so
 * stop/update/undefine removes everything.
 *
 * Configure (static composition): { awrBin, workdir, projectArg, dryRun,
 *   stalenessMs, heartbeatMs, resume, resumeWindowMs, ledgerPath }
 *   workdir      -> cwd for the awr CLI (AWR project root) and ledger default.
 *   projectArg   -> passed as awr --project; defaults to workdir.
 *   dryRun       -> log-only: never mutates AWR and never actually resumes
 *                   sessions (still detects staleness + maintains the ledger).
 *   stalenessMs  -> fake-death threshold since the last heartbeat (default 120s).
 *   heartbeatMs  -> watchdog poll interval (default 30s).
 *   resume       -> master switch for the REAL auto-resume of stale-but-live
 *                   sessions after a restart (default false; dryRun forces off).
 *   resumeWindowMs -> how recent a session's lastSeen must be to count as
 *                   "was active before reboot" (default 1h).
 *   ledgerPath   -> where the durable session ledger lives (default under
 *                   workdir/.dsh-tasksuite/sessions-ledger.json).
 */

const path = require('path')
const fs = require('fs')

module.exports = function makeAwrGoalSupervisor(configure) {
  const cfg = Object.assign(
    {
      awrBin: 'awr',
      workdir: '',
      projectArg: '',
      dryRun: false,
      stalenessMs: 120_000,
      heartbeatMs: 30_000,
      resume: false,
      resumeWindowMs: 3_600_000,
      ledgerPath: '',
    },
    configure || {},
  )

  return function awrGoalSupervisorPlugin() {
    return {
      name: 'awr-goal-supervisor',
      inject: ['shell', 'timer'],
      apply(ctx) {
        const SHELL = ctx.shell
        const AWR = cfg.awrBin
        const WD = cfg.workdir || ''
        const PROJ = cfg.projectArg ? ['--project', cfg.projectArg] : []
        const FS = ctx.get('fs')
        const AGENTS = ctx.get('agents')

        // ---- supervisor state (leaf scalars only; no live objects) ----
        let lastHeartbeat = Date.now()
        let lastBound = null // { work?: string, session?: string, turn?: number }
        let staleFired = false
        let recoveredOnThisStart = false

        // ---- durable SESSION LEDGER (survives restart) ----
        const defaultLedgerPath = WD
          ? path.join(WD, '.dsh-tasksuite', 'sessions-ledger.json')
          : ''
        const ledgerPath = cfg.ledgerPath || defaultLedgerPath
        let ledger = null // { version, sessions: { [sid]: { lastSeen } } }
        let ledgerDirty = false
        let bootResumeDone = false

        function shq(a) {
          const s = String(a == null ? '' : a)
          return "'" + s.replace(/'/g, "'\\''") + "'"
        }

        async function awr(args, opts) {
          const command = [AWR].concat(PROJ, args).map(shq).join(' ')
          const spec = SHELL.resolve({
            command,
            workdir: WD,
            timeoutMs: 20000,
            stdoutMaxBytes: 1_000_000,
          })
          try {
            const res = await SHELL.run(spec)
            return { ok: res.exitCode === 0 || res.exitCode === null, res }
          } catch (e) {
            return { ok: false, error: e && e.message }
          }
        }

        async function log(msg) {
          console.log('[awr-goal-supervisor] ' + msg)
        }

        // ------------------------------------------------------------------
        // SESSION LEDGER — record every agent we observe so, after a restart,
        // we know which sessions were active and can truly resume them.
        // ------------------------------------------------------------------
        function ledgerLoad() {
          if (ledger !== null) return Promise.resolve(ledger)
          if (!ledgerPath) {
            ledger = { version: 1, sessions: {} }
            return Promise.resolve(ledger)
          }
          if (FS) {
            return FS.resolve(ledgerPath)
              .then((target) =>
                FS.stat(target).then((info) => {
                  if (!info) return { version: 1, sessions: {} }
                  return FS.readText(target).then((txt) => {
                    try {
                      const parsed = JSON.parse(txt)
                      return (parsed && parsed.sessions)
                        ? parsed
                        : { version: 1, sessions: {} }
                    } catch (_e) {
                      return { version: 1, sessions: {} }
                    }
                  })
                }),
              )
              .then((l) => { ledger = l; return l })
              .catch(() => { ledger = { version: 1, sessions: {} }; return ledger })
          }
          // No fs service — best-effort via node fs in the host process.
          try {
            if (fs.existsSync(ledgerPath)) {
              const txt = fs.readFileSync(ledgerPath, 'utf8')
              const parsed = JSON.parse(txt)
              ledger = (parsed && parsed.sessions) ? parsed : { version: 1, sessions: {} }
            } else {
              ledger = { version: 1, sessions: {} }
            }
          } catch (_e) {
            ledger = { version: 1, sessions: {} }
          }
          return Promise.resolve(ledger)
        }

        function ledgerSave() {
          if (!ledgerDirty || !ledgerPath) return
          ledgerDirty = false
          const text = JSON.stringify(ledger)
          if (FS) {
            FS.resolve(ledgerPath).then((target) =>
              FS.writeText(target, text).catch((e) =>
                console.log('[awr-goal-supervisor] ledger write failed (fs): ' + (e && e.message)),
              ),
            )
            return
          }
          try {
            fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
            fs.writeFileSync(ledgerPath, text, 'utf8')
          } catch (e) {
            console.log('[awr-goal-supervisor] ledger write failed (node fs): ' + (e && e.message))
          }
        }

        function recordSession(sid) {
          if (!sid) return
          ledgerLoad().then(() => {
            if (!ledger.sessions[sid]) ledger.sessions[sid] = {}
            ledger.sessions[sid].lastSeen = Date.now()
            ledgerDirty = true
          })
        }

        // ------------------------------------------------------------------
        // RECONCILE + REAL AUTO-RESUME (on session-start): bring back sessions
        // that were active before the reboot and are no longer live.
        // ------------------------------------------------------------------
        async function reconcile(payload) {
          const source = payload && payload.source
          const sid = payload && payload.agent && payload.agent.id
          await log(
            'session-start (id=' + String(sid || '?') + ', source=' +
              (typeof source === 'string' ? source : '?') +
              ') — reconciling against AWR ledger',
          )
          if (sid) recordSession(sid)
          const st = await awr(['status'])
          if (!st.ok || !st.res) {
            await log('status lookup failed: ' + (st.error || (st.res && st.res.stderr && st.res.stderr.text)))
            return
          }
          const text = (st.res.stdout.text || '').trim()
          const head = text ? text.split('\n').slice(0, 3).join(' | ') : '(empty)'
          await log('AWR status head: ' + head)

          const staleMs = Date.now() - lastHeartbeat
          if (staleMs > cfg.stalenessMs) {
            await log(
              'STALE heartbeat detected at start (last heartbeat ' +
                Math.round(staleMs / 1000) + 's ago): previous run may have died ' +
                'or wedged.',
            )
          }
          recoveredOnThisStart = true
        }

        // REAL 拉起 (pull-up): after a reboot, actually resume sessions that
        // were active before the restart and are no longer in the live set.
        async function resumeStaleSessions() {
          if (bootResumeDone) return
          bootResumeDone = true
          await ledgerLoad()
          await log(
            'auto-resume scan: resume=' + String(cfg.resume) +
              ' dryRun=' + String(cfg.dryRun) +
              ' ledgerPath=' + (ledgerPath || '(none)') +
              ' sessions=' + (ledger.sessions ? Object.keys(ledger.sessions).length : 0),
          )
          if (!cfg.resume || cfg.dryRun) {
            if (cfg.dryRun && Object.keys(ledger.sessions || {}).length > 0) {
              await log(
                'dry-run: would auto-resume stale sessions, but dryRun is true — ' +
                  'set resume:true and dryRun:false to actually pull them back up.',
              )
            }
            return
          }
          // Safety gate: only pull sessions up when AWR still has unfinished
          // work. Prevents mass-resuming idle web sessions that have nothing
          // to continue.
          const st = await awr(['status'])
          const stText = st.ok && st.res ? (st.res.stdout.text || '') : ''
          // Real awr status summary looks like:
          //   "Continue: 2 | Claimable: 0 | Waiting: 0 | Blocked: 3"
          // Count any of continue/claimable/waiting/blocked that is non-zero as
          // unfinished work (case-insensitive; the CLI capitalizes the labels).
          const hasUnfinished = /(continue|claimable|waiting|blocked)\s*:\s*[1-9]/i.test(stText)
          if (!hasUnfinished) {
            await log('auto-resume: AWR has no unfinished work — nothing to pull up (skip).')
            return
          }
          if (!AGENTS) {
            await log('ctx.agents unavailable — cannot auto-resume (skip).')
            return
          }
          let live
          try {
            live = new Set((AGENTS.list() || []).map((a) => a && a.id))
          } catch (e) {
            await log('agents.list() failed: ' + (e && e.message))
            return
          }
          const now = Date.now()
          const candidates = Object.keys(ledger.sessions || {})
            .filter((sid) => {
              const rec = ledger.sessions[sid]
              const lastSeen = rec && rec.lastSeen
              if (!lastSeen) return false
              const recent = now - lastSeen < cfg.resumeWindowMs
              const notLive = !live.has(sid)
              return recent && notLive
            })
          if (!candidates.length) {
            await log('auto-resume: no stale-but-recent sessions to pull up.')
            return
          }
          await log('auto-resume: pulling up ' + candidates.length + ' session(s): ' + candidates.join(', '))
          for (const sid of candidates) {
            try {
              const handle = await AGENTS.resume({ resumeSessionId: sid })
              const resumedId = handle && handle.agent ? handle.agent.id : sid
              await log('RESUMED (pulled up) session ' + resumedId)
            } catch (e) {
              await log('auto-resume failed for ' + sid + ': ' + (e && e.message))
            }
          }
        }

        // ---- HEARTBEAT refresh at every step + safe boundary ----
        function beat(turn, bound) {
          lastHeartbeat = Date.now()
          if (bound) lastBound = bound
          staleFired = false
          if (typeof turn === 'number' && lastBound) lastBound.turn = turn
        }

        // ---- CHECKPOINT on safe serial turn boundary (write path) ----
        async function checkpoint(payload) {
          const turn = payload && payload.turn
          const sid = payload && payload.agent && payload.agent.id
          if (sid) recordSession(sid)
          beat(turn, lastBound)
          if (cfg.dryRun) {
            await log('turn-stopping@' + turn + ': heartbeat refreshed (dry-run, no AWR write)')
            return
          }
          await log('turn-stopping@' + turn + ': safe boundary, checkpointable')
        }

        // ---- WATCHDOG: detect fake-death while the process is alive ----
        function armWatchdog() {
          const disposer = ctx.interval(() => {
            // Debounced ledger flush rides the same tick.
            if (ledgerDirty) ledgerSave()

            const staleMs = Date.now() - lastHeartbeat
            if (staleMs > cfg.stalenessMs) {
              if (!staleFired) {
                staleFired = true
                const bound = lastBound
                  ? ' work=' + lastBound.work + ' session=' + lastBound.session
                  : ''
                console.log(
                  '[awr-goal-supervisor] FAKE-DEATH DETECTED' + bound + ': no heartbeat for ' +
                    Math.round(staleMs / 1000) + 's (threshold ' + Math.round(cfg.stalenessMs / 1000) +
                    's). The current turn is wedged or the loop stalled. ' +
                    (cfg.dryRun
                      ? 'dry-run: surfaced for OS-layer watchdog / external recovery.'
                      : 'Recovery: external watchdog should terminate this run; on restart ' +
                        'reconcile() will mark it stale and resume via AWR session.'),
                )
                if (!cfg.dryRun) {
                  awr(['recovery', 'check']).then((r) => {
                    const t = r.ok && r.res ? r.res.stdout.text : ''
                    console.log('[awr-goal-supervisor] awr recovery check: ' + (t || '(no output)'))
                  })
                }
              }
            } else {
              staleFired = false
            }
          }, cfg.heartbeatMs)
          ctx.on('dispose', () => disposer && disposer())
        }

        // ---- ERROR hook: a step/turn failed; still refresh heartbeat ----
        async function onError(payload) {
          const turn = payload && payload.turn
          const sid = payload && payload.agent && payload.agent.id
          if (sid) recordSession(sid)
          if (typeof turn === 'number') beat(turn, lastBound)
          await log(
            'agent/error@turn=' + turn + ' step=' + (payload && payload.step) +
              (cfg.dryRun ? ' (dry-run)' : ' — ledger owner should record evidence'),
          )
        }

        // ---- PRE-STEP (waterfall): refresh heartbeat, then pass through ----
        function onPreStep(payload, next) {
          const turn = payload && payload.turn
          const sid = payload && payload.agent && payload.agent.id
          if (sid) recordSession(sid)
          if (typeof turn === 'number') beat(turn, lastBound)
          return next()
        }

        armWatchdog()
        ctx.on('agent/session-start', (payload) => reconcile(payload).catch((e) => log('reconcile err: ' + e.message)))
        ctx.on('agent/turn-stopping', (payload) => checkpoint(payload).catch((e) => log('checkpoint err: ' + e.message)))
        ctx.on('agent/error', (payload) => onError(payload).catch((e) => log('hook err: ' + e.message)))
        ctx.on('agent/pre-step', onPreStep)

        // Seed the ledger + run the real pull-up scan shortly after arm, once.
        ledgerLoad().then(() => {
          recordSession(null) // no-op guard; ensure ledger object exists
        })
        ctx.timeout(() => {
          resumeStaleSessions().catch((e) => log('auto-resume scan err: ' + e.message))
        }, 1500)

        log(
          'armed. watchers: pre-step, turn-stopping, error, session-start, level=HEARTBEAT(' +
            Math.round(cfg.heartbeatMs / 1000) + 's)/STALE(' + Math.round(cfg.stalenessMs / 1000) +
            's)' + (cfg.dryRun ? ' [dry-run]' : '') +
            (cfg.resume ? ' [real-auto-resume]' : ''),
        )

        const bind = {
          work: cfg.work || undefined,
          session: cfg.session || undefined,
        }
        if (bind.work || bind.session) {
          lastBound = bind
          log('bound to work=' + bind.work + ' session=' + bind.session)
        }
      },
    }
  }
}
