/**
 * dsh-tasksuite / plugins/awr-tools
 *
 * Self-written DSH Host plugin that wraps the AWR CLI (`awr` 0.5.0) into a
 * small, model-visible set of Tools. It is the "state layer <-> execution
 * layer" glue: the agent reads AWR status / work / sessions through these
 * Tools without needing to shell out by hand.
 *
 * Mounting
 * --------
 * Static (production) usage: replace the `awrBin` / `workdir` in the apply
 * signature with values from your composition config, or see the dynamic
 * `cordis_define` path described in README. The apply body below is exactly
 * what cordis_define accepts as `code.host`.
 *
 * Design notes
 * ------------
 * - Uses `ctx.shell` (abstract bash execution service) via
 *   `ctx.shell.resolve(...)` -> `ctx.shell.run(...)` per the Inspect contract.
 * - Tools are registered with `harness.defineTool` + `harness.registerTool`
 *   (Host builtins) and are therefore part of the normal model-visible tool set.
 * - Read-only by default: only `awr ready/status/work show/session show`
 *   are exposed. Mutating/claiming commands live in awr-goal-supervisor so
 *   the supervisor owns the write path.
 */

module.exports = function makeAwrTools(configure) {
  const cfg = Object.assign(
    { awrBin: 'awr', workdir: '', timeoutMs: 30000 },
    configure || {},
  )

  // The Cordis Plugin. In dynamic mode (cordis_define) a trimmed equivalent
  // body is used; this factory is what a static composition mounts.
  return function awrToolsPlugin() {
    return {
      name: 'awr-tools',
      inject: ['tools', 'shell'],
      apply(ctx) {
        const AWR = cfg.awrBin
        const WORKDIR = cfg.workdir

        // Quote a single argv element for a POSIX shell command string.
        function shq(a) {
          const s = String(a == null ? '' : a)
          return "'" + s.replace(/'/g, "'\\''") + "'"
        }

        async function runAWR(args, workdir, timeoutMs) {
          const cmd = [AWR].concat(args).map(shq).join(' ')
          const spec = ctx.shell.resolve({
            command: cmd,
            workdir: workdir || WORKDIR,
            timeoutMs: timeoutMs || cfg.timeoutMs,
            stdoutMaxBytes: 2_000_000,
          })
          const res = await ctx.shell.run(spec)
          const stdout = res.stdout.text
          const stderr = res.stderr.text
          if (res.exitCode !== 0 && res.exitCode !== null) {
            return {
              ok: false,
              exitCode: res.exitCode,
              stdout,
              stderr: stderr || stdout,
            }
          }
          return { ok: true, exitCode: res.exitCode, stdout, stderr }
        }

        // Build a full JSON Schema for a Tool `parameters` object. The implicit
        // parameter root is always "open", so additionalProperties stays true
        // unless the caller opts out. `required` is an array of property names.
        function P(properties, required) {
          return {
            type: 'object',
            additionalProperties: true,
            properties: properties || {},
            required: required || [],
          }
        }

        // Same shape as the verified dynamic body: output.schema must carry an
        // explicit additionalProperties, and render returns ContentBlocks.
        function simpleTool(name, description, properties, required, argsFor) {
          const tool = harness.defineTool({
            name,
            description,
            parameters: P(properties, required),
            output: {
              schema: { type: 'object', additionalProperties: true },
              render(_a, v) {
                const text =
                  typeof v === 'string' ? v : v && v.stdout ? v.stdout : JSON.stringify(v)
                return [{ type: 'text', text }]
              },
            },
            async execute(args) {
              const r = await runAWR(argsFor(args), args.workdir)
              if (!r.ok) return { ok: false, error: r.stderr }
              return { ok: true, stdout: r.stdout }
            },
          })
          return harness.registerTool(ctx, tool)
        }

        const disposers = []
        disposers.push(
          simpleTool(
            'awr_status',
            'Show AWR project status: selected work, claimable/waiting/blocked counts, current item and next action. Reads the AWR work ledger in the configured project directory.',
            {},
            [],
            () => ['status'],
          ),
          simpleTool(
            'awr_ready',
            'List AWR work items that are currently claimable (ready to be picked up).',
            {},
            [],
            () => ['ready'],
          ),
          simpleTool(
            'awr_work_show',
            'Show one AWR work item in detail.',
            { key: { type: 'string' } },
            ['key'],
            (a) => ['work', 'show', a.key],
          ),
          simpleTool(
            'awr_session_show',
            'Show the AWR session bound to the current or a given session id.',
            { id: { type: 'string' } },
            [],
            (a) => (a.id ? ['session', 'show', a.id] : ['session', 'show']),
          ),
        )

        ctx.on('dispose', () => disposers.forEach((d) => d()))
      },
    }
  }
}
