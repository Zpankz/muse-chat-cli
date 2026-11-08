import assert from 'node:assert/strict'
import test from 'node:test'

process.env.MUSE_TRANSPORT = 'noise'
const { transport } = await import('../muse-transport.mjs')
const { MuseNoiseClient } = await import('../muse-noise.mjs')

test('reserved threads create before subscribing, preserve their id, then continue normally', async () => {
  const account = { id: 'test' }
  const calls = []
  const client = {
    closing: false,
    sessions: new Set(),
    _chatTurn: async (_prompt, opts) => {
      calls.push(opts)
      return { reply: 'ok', replyReady: true, sessionId: opts.sid }
    },
    chat(prompt, opts) { return MuseNoiseClient.prototype._chatOnce.call(this, prompt, opts) },
  }
  // Isolate the real transport methods from account discovery, uploads and network I/O.
  const t = Object.create(Object.getPrototypeOf(transport))
  t._acct = () => account
  t._ensure = async () => client
  t._uploadAll = async () => []
  const fresh = await t.newChat()
  const first = await t._run(account, 'first', { chat: fresh.session_id })
  const second = await t._run(account, 'second', { chat: fresh.session_id })
  assert.equal(first.sessionId, fresh.session_id)
  assert.equal(second.sessionId, fresh.session_id)
  assert.equal(calls[0].newSession, true)
  assert.equal(calls[1].newSession, false)
  assert.equal(calls[0].sid, fresh.session_id)

  // Exercise the actual new-session request/subscription ordering, stopping at subscribe.
  const order = []
  const stop = new Error('test stops at subscription')
  const wire = {
    async request(method, path, { body }) {
      order.push([method, path, body.session_id])
      return { status: 200 }
    },
    _ackOk() {},
    chatSubscribe({ sessionId }) { order.push(['subscribe', sessionId]); throw stop },
  }
  await assert.rejects(
    MuseNoiseClient.prototype._chatTurn.call(wire, 'first', calls[0]),
    (error) => error === stop,
  )
  assert.deepEqual(order, [
    ['POST', '/chat/stream', fresh.session_id],
    ['subscribe', fresh.session_id],
  ])
})

test('noise history targets resolve by UUID, list index and title, rejecting misses', async () => {
  const t = Object.create(Object.getPrototypeOf(transport))
  t._acct = () => ({ id: 'test' })
  const sid = '11111111-2222-3333-4444-555555555555'
  t.listChats = async () => ({ chats: [{ title: 'Video creation', session_id: sid }] })
  assert.equal(await t._sessionForTarget(sid), sid)
  assert.equal(await t._sessionForTarget('0'), sid)
  assert.equal(await t._sessionForTarget('video'), sid)
  assert.equal(await t._sessionForTarget(null), null)
  await assert.rejects(t._sessionForTarget('missing'), /no chat matching/)
})
