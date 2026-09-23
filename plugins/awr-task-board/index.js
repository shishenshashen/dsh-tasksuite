/**
 * dsh-tasksuite / plugins/awr-task-board (CLIENT + HOST)
 *
 * A live AWR task board in the DSH GUI. Unlike the read-only awr-tools Tools,
 * this surfaces AWR status/ready/work as a visible panel so an operator can
 * see, at a glance, what is claimable/waiting/blocked and what the supervisor
 * is currently doing with it.
 *
 * Split:
 *   HOST half — registers a Package-private RPC `awr-status` that shells out to
 *               the awr CLI and returns only leaf scalar strings (never live
 *               DSH data). Uses ctx.shell.
 *   CLIENT half — registers into a Slot (see the registration comment below)
 *               and calls host.call('awr-status') to refresh the board.
 *
 * Mounting
 * --------
 * Dynamic (cordis_define): provide both code.host and code.client (trimmed
 * equivalents of the factories below). A Client plugin creates an approval
 * request; when approval is disabled it stays awaiting-approval and the board
 * simply is not shown. Static composition mounts host + client rows separately.
 *
 * Slot choice (verified pattern from docs/): `settings.section` is the most
 * self-contained full-content surface (Slider registers {id, order, label}).
 * For a session-scoped quick view you can instead target an inner tab/overlay
 * Slot; adjust `SLOT` below and re-query Slots.listSubTree for the exact
 * registration key before shipping to a specific host.
 */

module.exports = function makeAwrTaskBoard(configure) {
  const cfg = Object.assign(
    { awrBin: 'awr', workdir: '', projectArg: '', refreshMs: 30_000 },
    configure || {},
  )

  // ---------------- HOST half ----------------
  function hostFactory() {
    return {
      name: 'awr-task-board-host',
      inject: ['shell'],
      apply(ctx) {
        const SHELL = ctx.shell
        const AWR = cfg.awrBin
        const WD = cfg.workdir || ''
        const PROJ = cfg.projectArg ? ['--project', cfg.projectArg] : []

        function shq(a) {
          const s = String(a == null ? '' : a)
          return "'" + s.replace(/'/g, "'\\''") + "'"
        }

        async function run(args) {
          const command = [AWR].concat(PROJ, args).map(shq).join(' ')
          const spec = SHELL.resolve({
            command,
            workdir: WD,
            timeoutMs: 15000,
            stdoutMaxBytes: 500_000,
          })
          const res = await SHELL.run(spec)
          return { exitCode: res.exitCode, stdout: res.stdout.text, stderr: res.stderr.text }
        }

        harness.handle('awr-status', async () => {
          // Only leaf strings cross the wire; no live objects.
          const status = await run(['status']).catch((e) => ({ error: e && e.message }))
          const ready = await run(['ready']).catch(() => null)
          return {
            status: status.stdout || status.error || '',
            exitCode: status.exitCode,
            ready: ready ? ready.stdout : '',
          }
        })

        console.log('[awr-task-board] host RPC `awr-status` armed')
      },
    }
  }

  // ---------------- CLIENT half ----------------
  function clientFactory() {
    // Returns a function producing the Client Plugin. React isn't imported;
    // it is provided by the Client runtime across the module scaffold. We keep
    // the body guarded so the static file parses even without a bundler.
    return function awrTaskBoardClientPlugin() {
      return {
        name: 'awr-task-board',
        async apply(ctx) {
          const slots = ctx.get('slots')
          if (slots === undefined) return

          // NOTE: adjust to a real Slot after re-querying Slots.listSubTree on
          // the target host (approval disabled here, so a live Client query is
          // cancelled). `settings.section` is a documented list Slot.
          const SLOT = cfg.slot || 'settings.section'
          const SECTION = cfg.section || 'awr-task-board'

          function TaskBoard(props) {
            const [state, setState] = React.useState({ status: '', ready: '', loading: true })
            React.useEffect(() => {
              let alive = true
              async function refresh() {
                try {
                  const r = await host.call('awr-status', {})
                  if (alive) setState({ status: r.status || '', ready: r.ready || '', loading: false })
                } catch (e) {
                  if (alive) setState({ status: 'RPC error: ' + (e && e.message), ready: '', loading: false })
                }
              }
              refresh()
              const id = ctx.interval(refresh, cfg.refreshMs || 30000)
              return () => { alive = false; id && id() }
            }, [])
            const pre = React.createElement(
              'pre',
              { style: { whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.4 } },
              state.loading ? 'loading…' : (state.status + '\n--- ready ---\n' + state.ready),
            )
            return React.createElement('div', { style: { padding: 8 } },
              React.createElement('h3', null, 'AWR Task Board'),
              pre,
            )
          }

          slots.inject(SLOT, () => slots.register(
            { name: SLOT, id: SECTION },
            TaskBoard,
          ))
        },
      }
    }
  }

  return { host: hostFactory, client: clientFactory }
}
