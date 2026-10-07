'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const CONFIG = {
  port: Math.floor(num(process.env.PORT, 3000)),
  maxFileMb: num(process.env.MAX_FILE_SIZE_MB, 25),
  maxMessageLength: Math.floor(num(process.env.MAX_MESSAGE_LENGTH, 2000)),
  historyLimit: Math.floor(num(process.env.HISTORY_LIMIT, 200)),
  retentionHours: num(process.env.UPLOAD_RETENTION_HOURS, 24),
  corsOrigin: (process.env.CORS_ORIGIN || '').trim(),
};
CONFIG.maxFileBytes = Math.floor(CONFIG.maxFileMb * 1024 * 1024);

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const REACTIONS = ['❤️', '😂', '😍', '😢', '😡', '👍', '🔥'];
const USERNAME_RE = /^[\p{L}\p{N} _.-]{1,24}$/u;

/* Files that could be executed if a user double-clicks them. */
const BLOCKED_EXTENSIONS = [
  'exe', 'bat', 'cmd', 'com', 'scr', 'msi', 'ps1', 'vbs', 'vbe', 'wsf',
  'jar', 'sh', 'dll', 'apk', 'app', 'dmg', 'reg', 'lnk', 'hta', 'cpl',
];

/* Only these are ever served inline (safe for <img>). Everything else is
   served as a forced download with a generic content type. */
const INLINE_IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

const KIND_BY_EXT = {};
const addKind = (kind, list) => list.forEach((ext) => (KIND_BY_EXT[ext] = kind));
addKind('image', Object.keys(INLINE_IMAGE_TYPES));
addKind('pdf', ['pdf']);
addKind('zip', ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz']);
addKind('doc', ['doc', 'docx', 'odt', 'rtf', 'pages']);
addKind('sheet', ['xls', 'xlsx', 'csv', 'ods', 'numbers']);
addKind('slides', ['ppt', 'pptx', 'odp', 'key']);
addKind('video', ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'wmv']);
addKind('audio', ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac']);
addKind('text', ['txt', 'md', 'log', 'json', 'xml', 'yml', 'yaml']);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const respond = (ack, payload) => {
  if (typeof ack === 'function') ack(payload);
};

function cleanFileName(raw) {
  let name = String(raw || '');
  // multer decodes multipart filenames as latin1; recover UTF-8 names.
  const recovered = Buffer.from(name, 'latin1').toString('utf8');
  if (!recovered.includes('\uFFFD')) name = recovered;
  name = path.basename(name.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim();
  if (!name || name === '.' || name === '..') name = 'file';
  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 12);
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name;
}

function extensionOf(name) {
  const ext = path.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext.slice(1) : '';
}

/* ------------------------------------------------------------------ */
/* App factory (also used by the test-suite)                           */
/* ------------------------------------------------------------------ */

function createApp() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    maxHttpBufferSize: 1e6,
    cors: CONFIG.corsOrigin
      ? { origin: CONFIG.corsOrigin.split(',').map((s) => s.trim()) }
      : undefined,
  });

  /* ---------------- in-memory state ---------------- */
  const users = new Map(); // socket.id -> { id, username, joinedAt }
  const messages = []; // newest last
  const messageIndex = new Map(); // id -> message
  const typing = new Map(); // socket.id -> expiry timer
  const files = new Map(); // stored name -> metadata of uploaded files

  /* ---------------- HTTP ---------------- */
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true, online: users.size }));

  /* Upload auth: only users who joined the chat may upload. */
  const requireJoinedUser = (req, res, next) => {
    const id = req.get('x-socket-id');
    if (!id || !users.has(id)) {
      return res.status(401).json({ error: 'Join the chat before uploading files.' });
    }
    req.socketId = id;
    next();
  };

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = extensionOf(cleanFileName(file.originalname));
      cb(null, crypto.randomBytes(16).toString('hex') + (ext ? `.${ext}` : ''));
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: CONFIG.maxFileBytes, files: 1, fields: 0 },
    fileFilter: (req, file, cb) => {
      const ext = extensionOf(cleanFileName(file.originalname));
      if (BLOCKED_EXTENSIONS.includes(ext)) {
        const err = new Error(`.${ext} files are not allowed for security reasons.`);
        err.code = 'BLOCKED_TYPE';
        return cb(err);
      }
      cb(null, true);
    },
  });

  app.post('/upload', requireJoinedUser, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file received.' });
    const name = cleanFileName(req.file.originalname);
    const ext = extensionOf(name);
    const meta = {
      id: req.file.filename,
      name,
      ext,
      size: req.file.size,
      kind: KIND_BY_EXT[ext] || 'file',
      url: `/uploads/${req.file.filename}`,
      uploader: req.socketId,
      uploadedAt: Date.now(),
      sent: false,
    };
    files.set(meta.id, meta);
    res.json({ fileId: meta.id, name: meta.name, size: meta.size, kind: meta.kind, ext: meta.ext });
  });

  /* Safe file delivery: strict name check, no directory listing, forced
     download for anything that is not a plain raster image. */
  app.get('/uploads/:name', (req, res) => {
    const name = req.params.name;
    if (!/^[a-f0-9]{32}(\.[a-z0-9]{1,10})?$/.test(name)) {
      return res.status(404).json({ error: 'File not found.' });
    }
    const full = path.join(UPLOAD_DIR, name);
    fs.access(full, fs.constants.R_OK, (err) => {
      if (err) return res.status(404).json({ error: 'File not found or expired.' });
      const ext = path.extname(name).slice(1);
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"
      );
      res.setHeader('Cache-Control', 'private, max-age=3600');
      if (INLINE_IMAGE_TYPES[ext]) {
        res.setHeader('Content-Type', INLINE_IMAGE_TYPES[ext]);
      } else {
        res.setHeader('Content-Type', 'application/octet-stream');
        const meta = files.get(name);
        const download = meta ? meta.name.replace(/["\\\r\n]/g, '_') : name;
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(download)}"; filename*=UTF-8''${encodeURIComponent(download)}`
        );
      }
      res.sendFile(full, { dotfiles: 'deny' });
    });
  });

  app.use(express.static(PUBLIC_DIR));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `File is too large. The limit is ${CONFIG.maxFileMb} MB.`
          : 'Upload rejected.';
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
    }
    if (err && err.code === 'BLOCKED_TYPE') return res.status(415).json({ error: err.message });
    console.error('[http error]', err);
    res.status(500).json({ error: 'Unexpected server error.' });
  });

  /* ---------------- chat helpers ---------------- */
  const publicUser = (u) => ({ id: u.id, username: u.username, joinedAt: u.joinedAt });
  const onlineList = () =>
    Array.from(users.values())
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map(publicUser);

  const serializeReactions = (m) => {
    const out = {};
    m.reactions.forEach((byUser, emoji) => {
      if (byUser.size) out[emoji] = Array.from(byUser, ([id, name]) => ({ id, name }));
    });
    return out;
  };

  const serializeMessage = (m) => ({
    id: m.id,
    type: m.type,
    sender: m.sender,
    text: m.text,
    file: m.file,
    ts: m.ts,
    reactions: serializeReactions(m),
  });

  const createMessage = (user, extra) => {
    const m = {
      id: crypto.randomUUID(),
      sender: { id: user.id, name: user.username },
      ts: Date.now(),
      reactions: new Map(),
      deliveredTo: new Set(),
      ...extra,
    };
    messages.push(m);
    messageIndex.set(m.id, m);
    while (messages.length > CONFIG.historyLimit) {
      messageIndex.delete(messages.shift().id);
    }
    return m;
  };

  const typingList = () =>
    Array.from(typing.keys())
      .filter((id) => users.has(id))
      .map((id) => ({ id, name: users.get(id).username }));

  const broadcastTyping = () => io.emit('typing:update', typingList());

  const stopTyping = (id) => {
    if (!typing.has(id)) return false;
    clearTimeout(typing.get(id));
    typing.delete(id);
    return true;
  };

  /* Simple per-socket rate limiter. */
  const allow = (socket, bucket, limit, windowMs) => {
    const now = Date.now();
    const state = (socket.data.rate = socket.data.rate || {});
    const entry = state[bucket];
    if (!entry || now > entry.resetAt) {
      state[bucket] = { count: 1, resetAt: now + windowMs };
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };

  /* ---------------- Socket.IO ---------------- */
  io.on('connection', (socket) => {
    const guard = (handler) => (...args) => {
      const last = args[args.length - 1];
      const ack = typeof last === 'function' ? last : null;
      const payload = isObject(args[0]) ? args[0] : {};
      try {
        handler(payload, ack);
      } catch (err) {
        console.error('[socket error]', err);
        respond(ack, { ok: false, error: 'Something went wrong on the server.' });
      }
    };
    const currentUser = () => users.get(socket.id);

    socket.on(
      'user:join',
      guard((payload, ack) => {
        if (currentUser()) return respond(ack, { ok: false, error: 'You have already joined.' });

        const username = String(payload.username || '').trim().replace(/\s+/g, ' ');
        if (!username) return respond(ack, { ok: false, error: 'Please enter a username.' });
        if (!USERNAME_RE.test(username)) {
          return respond(ack, {
            ok: false,
            error: 'Use 1–24 letters, numbers, spaces, dots, dashes or underscores.',
          });
        }
        const taken = Array.from(users.values()).some(
          (u) => u.username.toLowerCase() === username.toLowerCase()
        );
        if (taken) {
          return respond(ack, { ok: false, error: `"${username}" is already online. Pick another name.` });
        }

        const user = { id: socket.id, username, joinedAt: Date.now() };
        users.set(socket.id, user);

        respond(ack, {
          ok: true,
          me: publicUser(user),
          users: onlineList(),
          history: messages.map(serializeMessage),
          typing: typingList(),
          config: {
            reactions: REACTIONS,
            maxFileBytes: CONFIG.maxFileBytes,
            maxMessageLength: CONFIG.maxMessageLength,
            blockedExtensions: BLOCKED_EXTENSIONS,
          },
        });

        socket.broadcast.emit('user:joined', { user: publicUser(user), ts: Date.now() });
        io.emit('users:update', onlineList());
      })
    );

    socket.on(
      'message:send',
      guard((payload, ack) => {
        const user = currentUser();
        if (!user) return respond(ack, { ok: false, error: 'Join the chat first.' });
        if (!allow(socket, 'send', 20, 10000)) {
          return respond(ack, { ok: false, error: 'You are sending messages too fast.' });
        }
        if (typeof payload.text !== 'string') {
          return respond(ack, { ok: false, error: 'Message must be text.' });
        }
        const text = payload.text.replace(/\r\n/g, '\n').trim();
        if (!text) return respond(ack, { ok: false, error: 'Message is empty.' });
        if (text.length > CONFIG.maxMessageLength) {
          return respond(ack, {
            ok: false,
            error: `Message is too long (max ${CONFIG.maxMessageLength} characters).`,
          });
        }

        const message = createMessage(user, { type: 'text', text });
        const wire = serializeMessage(message);
        respond(ack, { ok: true, message: wire }); // ack first so status events arrive after it
        socket.broadcast.emit('message:new', wire);

        if (stopTyping(socket.id)) broadcastTyping();
      })
    );

    socket.on(
      'file:send',
      guard((payload, ack) => {
        const user = currentUser();
        if (!user) return respond(ack, { ok: false, error: 'Join the chat first.' });
        if (!allow(socket, 'send', 20, 10000)) {
          return respond(ack, { ok: false, error: 'You are sending too fast.' });
        }
        const meta = typeof payload.fileId === 'string' ? files.get(payload.fileId) : null;
        if (!meta || meta.uploader !== socket.id || meta.sent) {
          return respond(ack, { ok: false, error: 'That upload is not available to share.' });
        }
        meta.sent = true;

        const message = createMessage(user, {
          type: 'file',
          file: {
            name: meta.name,
            ext: meta.ext,
            size: meta.size,
            kind: meta.kind,
            url: meta.url,
          },
        });
        const wire = serializeMessage(message);
        respond(ack, { ok: true, message: wire });
        socket.broadcast.emit('message:new', wire);
      })
    );

    socket.on(
      'message:received',
      guard((payload) => {
        const user = currentUser();
        const m = typeof payload.id === 'string' ? messageIndex.get(payload.id) : null;
        if (!user || !m || m.sender.id === socket.id || m.deliveredTo.has(socket.id)) return;
        m.deliveredTo.add(socket.id);
        const sender = io.sockets.sockets.get(m.sender.id);
        if (sender) {
          sender.emit('message:status', { id: m.id, status: 'delivered', count: m.deliveredTo.size });
        }
      })
    );

    socket.on(
      'typing',
      guard((payload) => {
        const user = currentUser();
        if (!user) return;
        if (!allow(socket, 'typing', 30, 10000)) return;
        if (payload.isTyping === true) {
          const had = typing.has(socket.id);
          if (had) clearTimeout(typing.get(socket.id));
          // Safety net: clear the indicator if the client never says "stopped".
          const timer = setTimeout(() => {
            if (stopTyping(socket.id)) broadcastTyping();
          }, 6000);
          timer.unref?.();
          typing.set(socket.id, timer);
          if (!had) broadcastTyping();
        } else if (stopTyping(socket.id)) {
          broadcastTyping();
        }
      })
    );

    socket.on(
      'reaction:toggle',
      guard((payload, ack) => {
        const user = currentUser();
        if (!user) return respond(ack, { ok: false, error: 'Join the chat first.' });
        if (!allow(socket, 'react', 40, 10000)) {
          return respond(ack, { ok: false, error: 'Slow down a little.' });
        }
        const m = typeof payload.messageId === 'string' ? messageIndex.get(payload.messageId) : null;
        if (!m) return respond(ack, { ok: false, error: 'That message no longer exists.' });
        if (!REACTIONS.includes(payload.emoji)) {
          return respond(ack, { ok: false, error: 'Unsupported reaction.' });
        }

        let byUser = m.reactions.get(payload.emoji);
        if (!byUser) {
          byUser = new Map();
          m.reactions.set(payload.emoji, byUser);
        }
        if (byUser.has(socket.id)) byUser.delete(socket.id);
        else byUser.set(socket.id, user.username);

        io.emit('reaction:update', { messageId: m.id, reactions: serializeReactions(m) });
        respond(ack, { ok: true });
      })
    );

    socket.on('disconnect', () => {
      const user = currentUser();
      if (!user) return;
      users.delete(socket.id);
      const wasTyping = stopTyping(socket.id);
      io.emit('user:left', { user: publicUser(user), ts: Date.now() });
      io.emit('users:update', onlineList());
      if (wasTyping) broadcastTyping();
    });
  });

  /* ---------------- upload housekeeping ---------------- */
  const sweepUploads = () => {
    const cutoff = Date.now() - CONFIG.retentionHours * 3600 * 1000;
    fs.readdir(UPLOAD_DIR, (err, names) => {
      if (err) return;
      names.forEach((name) => {
        if (name.startsWith('.')) return;
        const full = path.join(UPLOAD_DIR, name);
        fs.stat(full, (statErr, st) => {
          if (statErr || !st.isFile() || st.mtimeMs > cutoff) return;
          fs.unlink(full, () => files.delete(name));
        });
      });
    });
  };
  sweepUploads();
  const sweeper = setInterval(sweepUploads, 3600 * 1000);
  sweeper.unref();

  server.on('close', () => clearInterval(sweeper));

  return { app, server, io, state: { users, messages, files } };
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

function start(port = CONFIG.port) {
  const ctx = createApp();
  return new Promise((resolve, reject) => {
    ctx.server.once('error', reject);
    ctx.server.listen(port, () => {
      ctx.port = ctx.server.address().port;
      resolve(ctx);
    });
  });
}

if (require.main === module) {
  start()
    .then((ctx) => {
      console.log(`\n  Huddle chat is running  →  http://localhost:${ctx.port}\n`);
      const shutdown = () => {
        console.log('\nShutting down…');
        ctx.io.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1500).unref();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${CONFIG.port} is already in use. Set a different PORT in .env.`);
      } else {
        console.error('Failed to start server:', err);
      }
      process.exit(1);
    });
}

module.exports = { start, createApp, CONFIG };
