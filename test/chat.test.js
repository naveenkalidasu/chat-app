'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { io } = require('socket.io-client');
const { start } = require('../server/server');

let ctx;
let base;
const clients = [];

const once = (socket, event, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), ms);
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });

const emit = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

async function connect() {
  const socket = io(base, { transports: ['websocket'], forceNew: true });
  clients.push(socket);
  await once(socket, 'connect');
  return socket;
}

async function joinAs(name) {
  const socket = await connect();
  const res = await emit(socket, 'user:join', { username: name });
  return { socket, res };
}

before(async () => {
  ctx = await start(0);
  base = `http://localhost:${ctx.port}`;
});

after(async () => {
  clients.forEach((c) => c.close());
  await new Promise((r) => ctx.io.close(r));
});

test('serves the frontend files', async () => {
  for (const file of ['/', '/style.css', '/script.js', '/socket.io/socket.io.js']) {
    const res = await fetch(base + file);
    assert.equal(res.status, 200, file);
  }
});

test('rejects empty, invalid and duplicate usernames', async () => {
  const s = await connect();
  assert.equal((await emit(s, 'user:join', { username: '   ' })).ok, false);
  assert.equal((await emit(s, 'user:join', { username: '<script>' })).ok, false);
  assert.equal((await emit(s, 'user:join', {})).ok, false);

  const a = await joinAs('Dupe Check');
  assert.equal(a.res.ok, true);
  const b = await connect();
  const dup = await emit(b, 'user:join', { username: 'dupe check' });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /already online/);
});

test('join, online list, typing, messages, status, reactions, leave', async () => {
  const naveen = await joinAs('Naveen');
  assert.equal(naveen.res.ok, true);
  assert.equal(naveen.res.me.id, naveen.socket.id);

  const joinedEvt = once(naveen.socket, 'user:joined');
  const listEvt = once(naveen.socket, 'users:update');
  const rahul = await joinAs('Rahul');
  assert.equal((await joinedEvt).user.username, 'Rahul');
  const names = (await listEvt).map((u) => u.username);
  assert.ok(names.includes('Naveen') && names.includes('Rahul'));
  assert.ok(naveen.res.config.reactions.length === 7);

  // typing
  const typingOn = once(rahul.socket, 'typing:update');
  naveen.socket.emit('typing', { isTyping: true });
  assert.deepEqual((await typingOn).map((t) => t.name), ['Naveen']);

  // message: broadcast + ack + delivered status; typing cleared on send
  const got = once(rahul.socket, 'message:new');
  const typingOff = once(rahul.socket, 'typing:update');
  const ack = await emit(naveen.socket, 'message:send', { text: 'Hello team 🔥' });
  assert.equal(ack.ok, true);
  const msg = await got;
  assert.equal(msg.text, 'Hello team 🔥');
  assert.equal(msg.sender.name, 'Naveen');
  assert.equal(msg.id, ack.message.id);
  assert.deepEqual(await typingOff, []);

  const status = once(naveen.socket, 'message:status');
  rahul.socket.emit('message:received', { id: msg.id });
  assert.deepEqual(await status, { id: msg.id, status: 'delivered', count: 1 });

  // validation
  assert.equal((await emit(naveen.socket, 'message:send', { text: '   ' })).ok, false);
  assert.equal((await emit(naveen.socket, 'message:send', { text: 'x'.repeat(5000) })).ok, false);
  assert.equal((await emit(naveen.socket, 'message:send', { text: 42 })).ok, false);

  // reactions toggle on/off and sync to everyone
  const r1 = once(naveen.socket, 'reaction:update');
  assert.equal((await emit(rahul.socket, 'reaction:toggle', { messageId: msg.id, emoji: '❤️' })).ok, true);
  const upd = await r1;
  assert.equal(upd.reactions['❤️'].length, 1);
  assert.equal(upd.reactions['❤️'][0].name, 'Rahul');

  const r2 = once(naveen.socket, 'reaction:update');
  await emit(rahul.socket, 'reaction:toggle', { messageId: msg.id, emoji: '❤️' });
  assert.deepEqual((await r2).reactions, {});

  assert.equal((await emit(rahul.socket, 'reaction:toggle', { messageId: msg.id, emoji: '💩' })).ok, false);
  assert.equal((await emit(rahul.socket, 'reaction:toggle', { messageId: 'nope', emoji: '❤️' })).ok, false);

  // new joiners get history
  const late = await joinAs('Late Joiner');
  assert.ok(late.res.history.some((m) => m.id === msg.id));

  // leave
  const left = once(naveen.socket, 'user:left');
  const listWithoutRahul = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no users:update without Rahul')), 3000);
    naveen.socket.on('users:update', (users) => {
      if (!users.some((u) => u.username === 'Rahul')) {
        clearTimeout(t);
        resolve(users);
      }
    });
  });
  rahul.socket.close();
  assert.equal((await left).user.username, 'Rahul');
  const finalList = await listWithoutRahul;
  assert.ok(finalList.some((u) => u.username === 'Naveen'));
});

test('file upload: auth, sharing, safe delivery, blocked types, size limit', async () => {
  const sender = await joinAs('Uploader');
  const viewer = await joinAs('Viewer');

  // unauthenticated upload is refused
  const fd0 = new FormData();
  fd0.append('file', new Blob(['hi']), 'a.txt');
  assert.equal((await fetch(`${base}/upload`, { method: 'POST', body: fd0 })).status, 401);

  const upload = async (blob, name, who = sender.socket.id) => {
    const fd = new FormData();
    fd.append('file', blob, name);
    return fetch(`${base}/upload`, { method: 'POST', body: fd, headers: { 'x-socket-id': who } });
  };

  // blocked executable
  assert.equal((await upload(new Blob(['MZ']), 'virus.exe')).status, 415);

  // valid PNG (1x1)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const okRes = await upload(new Blob([png], { type: 'image/png' }), '../../evil/pic ünï.png');
  assert.equal(okRes.status, 200);
  const meta = await okRes.json();
  assert.equal(meta.kind, 'image');
  assert.ok(!meta.name.includes('/') && !meta.name.includes('..'));
  assert.ok(meta.name.endsWith('.png'));

  // someone else can't share my upload
  assert.equal((await emit(viewer.socket, 'file:send', { fileId: meta.fileId })).ok, false);

  const incoming = once(viewer.socket, 'message:new');
  const ack = await emit(sender.socket, 'file:send', { fileId: meta.fileId });
  assert.equal(ack.ok, true);
  const msg = await incoming;
  assert.equal(msg.type, 'file');
  assert.equal(msg.file.kind, 'image');
  assert.ok(msg.file.size > 0);

  // can't share twice
  assert.equal((await emit(sender.socket, 'file:send', { fileId: meta.fileId })).ok, false);

  // image served inline with correct type, hardened headers
  const img = await fetch(base + msg.file.url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.match(img.headers.get('content-security-policy'), /sandbox/);

  // html uploaded → forced download, never rendered
  const html = await (await upload(new Blob(['<script>alert(1)</script>']), 'x.html')).json();
  const htmlRes = await fetch(`${base}/uploads/${html.fileId}`);
  assert.equal(htmlRes.headers.get('content-type'), 'application/octet-stream');
  assert.match(htmlRes.headers.get('content-disposition'), /attachment/);

  // path traversal / bad names
  assert.equal((await fetch(`${base}/uploads/..%2Fserver.js`)).status, 404);
  assert.equal((await fetch(`${base}/uploads/${'0'.repeat(32)}`)).status, 404);

  // size limit
  const tooBig = new Blob([Buffer.alloc(ctx.state ? 26 * 1024 * 1024 : 0)]);
  assert.equal((await upload(tooBig, 'big.zip')).status, 413);

  // cleanup uploaded test files
  const dir = path.join(__dirname, '..', 'server', 'uploads');
  fs.readdirSync(dir).filter((f) => !f.startsWith('.')).forEach((f) => fs.unlinkSync(path.join(dir, f)));
});
