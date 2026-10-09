/**
 * dsh-tasksuite / awr-goal-supervisor — Cordis host-composition wrapper.
 *
 * The plugin body (plugins/awr-goal-supervisor/index.js) exports a
 * double-curried factory (make(configure)() -> { name, inject, apply }),
 * which Cordis cannot mount directly: registry.resolve() treats a function
 * as the apply body. This wrapper reduces it to a standard
 * `{ inject, apply }` plugin object. It consumes only host-plane services
 * (shell, timer) and listens to host agent events, so it is a host
 * composition row — one process-global instance that observes every session.
 */
'use strict'

const make = require('./index.js')

module.exports = {
  inject: ['shell', 'timer'],
  apply(ctx, config) {
    // DSH core 0.2.0-rc.1 移除了 ctx.shell.run（改为 execute()().result()）。
    // 仅当 run 不存在而 execute 存在时补上 —— 在 0.1.5 上是 no-op，回滚零副作用。
    if (typeof ctx.shell.run !== 'function' && typeof ctx.shell.execute === 'function') {
      ctx.shell.run = async (spec) => (await ctx.shell.execute(spec)).result()
    }
    const desc = make(config || {})()
    return desc.apply(ctx)
  },
}
