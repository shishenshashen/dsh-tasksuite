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
    const desc = make(config || {})()
    return desc.apply(ctx)
  },
}
