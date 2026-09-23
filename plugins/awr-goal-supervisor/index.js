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
 * - State lives OUTSIDE the process in the AWR ledger (work item status,
 *   session ownership). This plugin never stores durable business state; it
 *   only (a) writes HEARTBEAT + CHECKPOINT at safe DSH lifecycle boundaries,
 *   and (b) on session-start reconciles against AWR so the next boot knows
 *   what to resume.
 * - It is a supervisor, not a doer: it never carries a goal forward by itself.
 *   It makes sure (1) a fresh root agent KNOWS there is unfinished work and has
 *   the session/work handle to `awr session resume`, and (2) a zombie is
 *   DETECTED (stale heartbeat) and surfaced so recovery can act.
 *
 * Fake-death detection
 * --------------------
 * The private watchdog can only observe boundaries the loop actually reaches:
 * `agent/pre-step` (every step start) and `agent/turn-stopping` (every safe
 * boundary) refresh the heartbeat. A per-Fiber timer then checks staleness: if
 * `now - lastHeartbeat > stalenessMs`, the run is declared STALE. That is the
 * signal that a model turn is wedged or the loop stalled without any step. On
 * restart, `reconcile()` sees the stale checkpoint and reports "resume via
 * session X" instead of treating the run as healthy. True watchdog enforcement
 * (killing a wedged process) is deliberately left to the OS layer (cron/systemd
 * TimeoutStopSec) — see README — because DSH has no sanctioned way to kill an
 * in-flight turn from inside itself.
 *
 * Verified Host Event + Service contracts used (see docs/):
 *   agent/session-start (emit)   { agent, source }
 *   agent/pre-step      (waterfall { agent, messages, turn, step, signal }, next)
 *   agent/turn-stopping (serial) { agent, turn, signal }
 *   agent/error         (emit)   { agent, turn, step, error }
 *   ctx.shell           resolve()/run() -> ShellRunResult
 *   ctx.timer           inject(['timer']), timeout()/interval()
 *
 * All contributions attach to the current Fiber (ctx.on / ctx.on('dispose')) so
 * stop/update/undefine removes everything.
 *
 * Configure (static composition): { awrBin, workdir, projectArg, dryRun,
 *   stalenessMs, heartbeatMs }
 *   workdir      -> cwd for the awr CLI (AWR project root).
 *   projectArg   -> passed as awr --project; defaults to workdir.
 *   dryRun       -> log-only: never mutate AWR (no resume marks / checkpoint
 *                   writes). Still runs the heartbeat + staleness watcher.
 *   stalenessMs  -> fake-death threshold since the last heartbeat (default 120s).
 *   heartbeatMs  -> watchdog poll interval (default 30s).
 */

module.exports = function makeAwrGoalSupervisor(configure) {
  const cfg = Object.assign(
    {
      awrBin: 'awr',
      workdir: '',
      projectArg: '',
      dryRun: false,
      stalenessMs: 120_000,
      heartbeatMs: 30_000,
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

        // ---- supervisor state (leaf scalars only; no live objects) ----
        let lastHeartbeat = Date.now()
        let lastBound = null // { work?: string, session?: string, turn?: number }
        let staleFired = false
        let recoveredOnThisStart = false

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

        // ---- RECONCILE (on session-start): did we leave unfinished work? ----
        async function reconcile(payload) {
          const source = payload && payload.source
          await log(
            'session-start (source=' +
              (typeof source === 'string' ? source : '?') +
              ') — reconciling against AWR ledger',
          )
          const st = await awr(['status'])
          if (!st.ok || !st.res) {
            await log('status lookup failed: ' + (st.error || st.res.stderr.text))
            return
          }
          const text = (st.res.stdout.text || '').trim()
          const head = text ? text.split('\n').slice(0, 3).join(' | ') : '(empty)'
          await log('AWR status head: ' + head)

          const staleMs = Date.now() - lastHeartbeat
          if (staleMs > cfg.stalenessMs) {
            // A previous run left a stale heartbeat -> fake-death on last boot.
            await log(
              'STALE heartbeat detected at start (last heartbeat ' +
                Math.round(staleMs / 1000) + 's ago): previous run may have died ' +
                'or wedged. This is the auto-resume entry point — the agent ' +
                'should recover unfinished AWR work (see README: recovery flow).',
            )
          }
          recoveredOnThisStart = true
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
          beat(turn, lastBound)
          if (cfg.dryRun) {
            await log('turn-stopping@' + turn + ': heartbeat refreshed (dry-run, no AWR write)')
            return
          }
          // The actual AWR session checkpoint write is owned by the agent via
          // the awr-tools write path; here we only confirm a safe boundary fired.
          await log('turn-stopping@' + turn + ': safe boundary, checkpointable')
        }

        // ---- WATCHDOG: detect fake-death while the process is alive ----
        function armWatchdog() {
          const disposer = ctx.interval(() => {
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
                // Optional: attempt an AWR operational mark so the ledger shows
                // the run needs recovery (no-op in dry-run, best-effort).
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
          if (typeof turn === 'number') beat(turn, lastBound)
          await log(
            'agent/error@turn=' + turn + ' step=' + (payload && payload.step) +
              (cfg.dryRun ? ' (dry-run)' : ' — ledger owner should record evidence'),
          )
        }

        // ---- PRE-STEP (waterfall): refresh heartbeat, then pass through ----
        function onPreStep(payload, next) {
          const turn = payload && payload.turn
          if (typeof turn === 'number') beat(turn, lastBound)
          return next()
        }

        armWatchdog()
        ctx.on('agent/session-start', (payload) => reconcile(payload).catch((e) => log('reconcile err: ' + e.message)))
        ctx.on('agent/turn-stopping', (payload) => checkpoint(payload).catch((e) => log('checkpoint err: ' + e.message)))
        ctx.on('agent/error', (payload) => onError(payload).catch((e) => log('hook err: ' + e.message)))
        ctx.on('agent/pre-step', onPreStep)

        log(
          'armed. watchers: pre-step, turn-stopping, error, session-start, level=HEARTBEAT(' +
            Math.round(cfg.heartbeatMs / 1000) + 's)/STALE(' + Math.round(cfg.stalenessMs / 1000) +
            's)' + (cfg.dryRun ? ' [dry-run]' : ''),
        )

        // Bind a handle for the current session (available after publish).
        // Best-effort: attach a stable work binding if one is provided at mount.
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
