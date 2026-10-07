(() => {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Setup                                                               */
  /* ------------------------------------------------------------------ */
  const $ = (sel) => document.querySelector(sel);
  const el = {
    join: $('#join'), joinForm: $('#joinForm'), nameInput: $('#nameInput'),
    joinError: $('#joinError'), joinBtn: $('#joinBtn'),
    app: $('#app'), sidebar: $('#sidebar'), scrim: $('#scrim'),
    menuBtn: $('#menuBtn'), closeSidebar: $('#closeSidebar'),
    userList: $('#userList'), sideCount: $('#sideCount'), onlineCount: $('#onlineCount'),
    meAvatar: $('#meAvatar'), meName: $('#meName'), meId: $('#meId'), leaveBtn: $('#leaveBtn'),
    chat: $('#chat'), conn: $('#conn'), messages: $('#messages'), jumpBtn: $('#jumpBtn'),
    typing: $('#typing'), uploads: $('#uploads'),
    picker: $('#picker'), quick: $('#quickEmoji'), grid: $('#emojiGrid'),
    emojiBtn: $('#emojiBtn'), attachBtn: $('#attachBtn'), fileInput: $('#fileInput'),
    input: $('#input'), sendBtn: $('#sendBtn'),
    reactBar: $('#reactBar'), toasts: $('#toasts'),
  };

  const state = {
    me: null,
    username: '',
    joined: false,
    users: [],
    typers: [],
    messages: new Map(),
    status: new Map(),
    config: {
      reactions: ['❤️', '😂', '😍', '😢', '😡', '👍', '🔥'],
      maxFileBytes: 25 * 1024 * 1024,
      maxMessageLength: 2000,
      blockedExtensions: [],
    },
  };

  const USERNAME_RE = /^[\p{L}\p{N} _.-]{1,24}$/u;
  const socket = io({ reconnectionDelayMax: 3000 });

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const hueOf = (name) => {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  };

  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&'));

  const initialOf = (name) => Array.from(String(name).trim())[0] || '?';

  const makeAvatar = (name, extra) => {
    const a = make('div', 'avatar' + (extra ? ' ' + extra : ''), initialOf(name));
    a.style.setProperty('--h', hueOf(name));
    return a;
  };

  const formatTime = (ts) =>
    new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, i);
    return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
  };

  let toastSeq = 0;
  const toast = (message, kind) => {
    const t = make('div', 'toast' + (kind === 'info' ? ' info' : ''), message);
    t.dataset.n = ++toastSeq;
    el.toasts.append(t);
    setTimeout(() => t.remove(), 4200);
  };

  /* ------------------------------------------------------------------ */
  /* Animated emoji                                                      */
  /* ------------------------------------------------------------------ */
  const EMOJI_ANIM = {
    '❤️': 'heart', '❤': 'heart',
    '😂': 'laugh', '🤣': 'laugh',
    '😭': 'cry', '😢': 'cry',
    '😡': 'angry', '🤬': 'angry',
    '🎉': 'party', '🥳': 'party',
    '🔥': 'fire',
  };
  const EMOJI_SPLIT = /(❤️|❤|😂|🤣|😭|😢|😡|🤬|🎉|🥳|🔥)/;
  const EMOJI_ONLY =
    /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*\s*){1,3}$/u;

  const fillText = (target, text) => {
    text.split(EMOJI_SPLIT).forEach((part, i) => {
      if (!part) return;
      if (i % 2 === 1) target.append(make('span', `emo emo-${EMOJI_ANIM[part]}`, part));
      else target.append(document.createTextNode(part));
    });
  };

  const emojiNode = (emoji) => {
    const kind = EMOJI_ANIM[emoji];
    return kind ? make('span', `emo emo-${kind}`, emoji) : document.createTextNode(emoji);
  };

  /* ------------------------------------------------------------------ */
  /* Join / leave                                                        */
  /* ------------------------------------------------------------------ */
  const emitJoin = (username) =>
    new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) resolve({ ok: false, error: 'The server did not respond. Try again.' });
      }, 8000);
      socket.emit('user:join', { username }, (res) => {
        done = true;
        clearTimeout(timer);
        resolve(res || { ok: false, error: 'No response from the server.' });
      });
    });

  const applyJoin = (res) => {
    state.me = res.me;
    state.username = res.me.username;
    state.config = res.config;
    state.users = res.users;
    state.typers = (res.typing || []).filter((t) => t.id !== res.me.id);
    state.joined = true;

    el.join.hidden = true;
    el.app.hidden = false;
    el.meName.textContent = res.me.username;
    el.meId.textContent = `id ${res.me.id}`;
    el.meId.title = `Your unique Socket.IO ID: ${res.me.id}`;
    el.meAvatar.replaceWith(Object.assign(makeAvatar(res.me.username), { id: 'meAvatar' }));
    el.meAvatar = $('#meAvatar');
    el.input.maxLength = state.config.maxMessageLength;

    renderUsers();
    renderTyping();
    renderHistory(res.history);
  };

  el.joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = el.nameInput.value.trim().replace(/\s+/g, ' ');
    el.joinError.textContent = '';
    if (!name) {
      el.joinError.textContent = 'Please enter a username.';
      el.nameInput.focus();
      return;
    }
    if (!USERNAME_RE.test(name)) {
      el.joinError.textContent = 'Use 1–24 letters, numbers, spaces, dots, dashes or underscores.';
      return;
    }
    if (!socket.connected) {
      el.joinError.textContent = 'Still connecting to the server. Try again in a moment.';
      return;
    }
    el.joinBtn.disabled = true;
    const res = await emitJoin(name);
    el.joinBtn.disabled = false;
    if (!res.ok) {
      el.joinError.textContent = res.error;
      return;
    }
    applyJoin(res);
    el.input.focus();
  });

  el.leaveBtn.addEventListener('click', () => {
    state.joined = false;
    state.username = '';
    state.me = null;
    closeSidebar();
    closePicker();
    stopTyping();
    el.messages.replaceChildren();
    state.messages.clear();
    state.status.clear();
    el.uploads.replaceChildren();
    el.app.hidden = true;
    el.join.hidden = false;
    el.nameInput.value = '';
    el.nameInput.focus();
    socket.disconnect();
    socket.connect();
  });

  /* ------------------------------------------------------------------ */
  /* Connection                                                          */
  /* ------------------------------------------------------------------ */
  socket.on('connect', async () => {
    el.conn.hidden = true;
    if (!state.username) return;
    const res = await emitJoin(state.username);
    if (res.ok) {
      applyJoin(res);
    } else {
      state.joined = false;
      state.username = '';
      el.app.hidden = true;
      el.join.hidden = false;
      el.joinError.textContent = `${res.error} (You were disconnected.)`;
    }
  });
  socket.on('disconnect', () => {
    if (state.joined) el.conn.hidden = false;
  });
  socket.on('connect_error', () => {
    if (state.joined) el.conn.hidden = false;
  });

  /* ------------------------------------------------------------------ */
  /* Online users                                                        */
  /* ------------------------------------------------------------------ */
  const renderUsers = () => {
    el.userList.replaceChildren();
    state.users.forEach((u) => {
      const li = make('li');
      li.title = `Socket ID: ${u.id}`;
      li.append(makeAvatar(u.username));
      const name = make('span', 'uname', u.username);
      if (state.me && u.id === state.me.id) name.append(make('span', 'you', ' (you)'));
      li.append(name, make('span', 'status-dot'));
      li.lastChild.setAttribute('aria-label', 'online');
      el.userList.append(li);
    });
    el.sideCount.textContent = state.users.length;
    el.onlineCount.textContent = state.users.length;
  };

  socket.on('users:update', (list) => {
    state.users = Array.isArray(list) ? list : [];
    renderUsers();
  });
  socket.on('user:joined', ({ user }) => addNotice(`${user.username} joined the room`));
  socket.on('user:left', ({ user }) => addNotice(`${user.username} left the room`));

  /* ------------------------------------------------------------------ */
  /* Scrolling                                                           */
  /* ------------------------------------------------------------------ */
  let stick = true;
  const nearBottom = () =>
    el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 90;
  const scrollToBottom = (instant) => {
    el.messages.scrollTo({ top: el.messages.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
    stick = true;
    el.jumpBtn.hidden = true;
  };
  el.messages.addEventListener('scroll', () => {
    stick = nearBottom();
    if (stick) el.jumpBtn.hidden = true;
  });
  el.jumpBtn.addEventListener('click', () => scrollToBottom(false));

  /* ------------------------------------------------------------------ */
  /* Messages                                                            */
  /* ------------------------------------------------------------------ */
  let lastSender = null;
  let lastTs = 0;

  const addNotice = (text) => {
    const wasNear = nearBottom();
    el.messages.append(make('div', 'notice', text));
    lastSender = null;
    if (wasNear) scrollToBottom(false);
  };

  const FILE_COLORS = {
    pdf: '#e5484d', zip: '#f5a524', doc: '#3b82f6', sheet: '#22a06b', slides: '#f97316',
    video: '#a855f7', audio: '#ec4899', text: '#64748b', image: '#14b8a6', file: '#6b7280',
  };
  const KIND_LABEL = {
    image: 'Image', pdf: 'PDF document', zip: 'Archive', doc: 'Document', sheet: 'Spreadsheet',
    slides: 'Presentation', video: 'Video', audio: 'Audio', text: 'Text file', file: 'File',
  };
  const FILE_GLYPH = { pdf: 'PDF', zip: 'ZIP', doc: 'DOC', sheet: 'XLS', slides: 'PPT', text: 'TXT' };

  const fileIcon = (kind, ext) => {
    const color = FILE_COLORS[kind] || FILE_COLORS.file;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 40 48');
    svg.setAttribute('class', 'ficon');
    svg.setAttribute('aria-hidden', 'true');
    const page = document.createElementNS(ns, 'path');
    page.setAttribute('d', 'M6 2h20l10 10v32a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z');
    page.setAttribute('fill', color);
    const fold = document.createElementNS(ns, 'path');
    fold.setAttribute('d', 'M26 2v10h10z');
    fold.setAttribute('fill', 'rgba(255,255,255,0.4)');
    svg.append(page, fold);

    if (kind === 'video' || kind === 'audio' || kind === 'image') {
      const glyph = document.createElementNS(ns, 'path');
      glyph.setAttribute('fill', '#fff');
      glyph.setAttribute(
        'd',
        kind === 'video' ? 'M16 24l12 7-12 7z'
          : kind === 'audio' ? 'M24 22v11.5a3.5 3.5 0 1 1-2-3.2V25l9-2v8.5a3.5 3.5 0 1 1-2-3.2V20z'
          : 'M11 40l8-10 5 6 4-5 6 9zM15 25a3 3 0 1 0 0.01 0z'
      );
      svg.append(glyph);
    } else {
      const label = FILE_GLYPH[kind] || String(ext || 'FILE').replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || 'FILE';
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('x', '20');
      text.setAttribute('y', '36');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', label.length > 3 ? '9' : '11');
      text.setAttribute('font-weight', '800');
      text.setAttribute('fill', '#fff');
      text.setAttribute('font-family', 'Manrope, system-ui, sans-serif');
      text.textContent = label;
      svg.append(text);
    }
    return svg;
  };

  const downloadIcon =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 11l5 5 5-5M5 21h14"/></svg>';

  const buildFile = (file) => {
    const wrap = make('div', 'file');
    if (file.kind === 'image') {
      const link = make('a', 'thumb');
      link.href = file.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const img = new Image();
      img.src = file.url;
      img.alt = file.name;
      img.loading = 'lazy';
      img.addEventListener('load', () => { if (stick) scrollToBottom(true); });
      img.addEventListener('error', () => {
        link.replaceWith(make('div', 'fmeta', 'Preview unavailable (file expired).'));
      });
      link.append(img);
      wrap.append(link);
    }
    const row = make('div', 'file-row');
    const info = make('div', 'finfo');
    const name = make('span', 'fname', file.name);
    name.title = file.name;
    info.append(name, make('span', 'fmeta', `${KIND_LABEL[file.kind] || 'File'} · ${formatBytes(file.size)}`));
    const dl = make('a', 'dl');
    dl.href = file.url;
    dl.setAttribute('download', file.name);
    dl.innerHTML = `${downloadIcon}<span>Download</span>`;
    dl.setAttribute('aria-label', `Download ${file.name}`);
    row.append(fileIcon(file.kind, file.ext), info, dl);
    wrap.append(row);
    return wrap;
  };

  const statusText = (id, mine) => {
    if (!mine) return '';
    if (String(id).startsWith('tmp-')) return 'Sending…';
    const s = state.status.get(id);
    if (s && s.status === 'delivered') return `✓✓ Delivered to ${s.count}`;
    return '✓ Sent';
  };

  const updateStatus = (id) => {
    const node = el.messages.querySelector(`.msg[data-id="${esc(id)}"] .status`);
    if (!node) return;
    const s = state.status.get(id);
    node.textContent = statusText(id, true);
    node.classList.toggle('delivered', !!(s && s.status === 'delivered'));
  };

  const renderReactions = (node, reactions) => {
    const box = node.querySelector('.reactions');
    box.replaceChildren();
    state.config.reactions.forEach((emoji) => {
      const list = reactions && reactions[emoji];
      if (!list || !list.length) return;
      const mine = state.me && list.some((u) => u.id === state.me.id);
      const chip = make('button', 'chip' + (mine ? ' mine' : ''));
      chip.type = 'button';
      chip.append(document.createTextNode(emoji), make('b', '', String(list.length)));
      chip.title = list.map((u) => u.name).join(', ');
      chip.setAttribute('aria-pressed', String(!!mine));
      chip.setAttribute('aria-label', `${emoji} ${list.length}. ${mine ? 'Remove' : 'Add'} your reaction`);
      chip.addEventListener('click', () => toggleReaction(node.dataset.id, emoji));
      box.append(chip);
    });
  };

  const buildMessage = (m, pending) => {
    const mine = !!state.me && m.sender.id === state.me.id;
    const first = !(lastSender === m.sender.id && m.ts - lastTs < 120000);
    const node = make('article', `msg ${mine ? 'mine' : 'theirs'}${first ? ' first' : ''}${pending ? ' pending' : ''}`);
    node.dataset.id = m.id;
    node.style.setProperty('--h', hueOf(m.sender.name));

    if (!mine) node.append(first ? makeAvatar(m.sender.name) : makeAvatar(m.sender.name, 'ghost'));

    const stack = make('div', 'stack');
    if (!mine && first) stack.append(make('span', 'sender', m.sender.name));

    const row = make('div', 'row');
    const bubble = make('div', 'bubble');
    if (m.type === 'file' && m.file) {
      bubble.append(buildFile(m.file));
    } else {
      const text = make('div', 'text');
      fillText(text, m.text || '');
      if (EMOJI_ONLY.test(m.text || '')) bubble.classList.add('emoji-only');
      bubble.append(text);
    }
    bubble.append(make('div', 'foot', formatTime(m.ts)));

    const react = make('button', 'react-btn');
    react.type = 'button';
    react.title = 'React';
    react.setAttribute('aria-label', 'Add reaction');
    react.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9.5h.01M15 9.5h.01"/></svg>';
    react.addEventListener('click', (e) => {
      e.stopPropagation();
      openReactBar(react, node);
    });

    row.append(bubble, react);
    stack.append(row, make('div', 'reactions'));
    if (mine) {
      const st = make('div', 'status', statusText(m.id, true));
      stack.append(st);
    }
    node.append(stack);
    renderReactions(node, m.reactions);

    lastSender = m.sender.id;
    lastTs = m.ts;
    return node;
  };

  const addMessage = (m, { pending = false, history = false } = {}) => {
    const wasNear = nearBottom();
    const node = buildMessage(m, pending);
    state.messages.set(m.id, m);
    el.messages.append(node);
    const mine = state.me && m.sender.id === state.me.id;
    if (history) return node;
    if (mine || wasNear) scrollToBottom(false);
    else el.jumpBtn.hidden = false;
    if (mine && !pending) updateStatus(m.id);
    return node;
  };

  const renderHistory = (history) => {
    el.messages.replaceChildren();
    state.messages.clear();
    state.status.clear();
    lastSender = null;
    lastTs = 0;
    (history || []).forEach((m) => addMessage(m, { history: true }));
    scrollToBottom(true);
  };

  socket.on('message:new', (m) => {
    addMessage(m);
    socket.emit('message:received', { id: m.id });
  });

  socket.on('message:status', ({ id, status, count }) => {
    state.status.set(id, { status, count });
    updateStatus(id);
  });

  socket.on('reaction:update', ({ messageId, reactions }) => {
    const m = state.messages.get(messageId);
    if (m) m.reactions = reactions;
    const node = el.messages.querySelector(`.msg[data-id="${esc(messageId)}"]`);
    if (node) renderReactions(node, reactions);
    if (!el.reactBar.hidden && el.reactBar.dataset.id === messageId) refreshReactBar();
  });

  /* ------------------------------------------------------------------ */
  /* Reactions                                                           */
  /* ------------------------------------------------------------------ */
  const toggleReaction = (messageId, emoji) => {
    if (!messageId || String(messageId).startsWith('tmp-')) return;
    if (!socket.connected) return toast('You are offline. Reconnecting…');
    socket.emit('reaction:toggle', { messageId, emoji }, (res) => {
      if (res && !res.ok) toast(res.error);
    });
  };

  const refreshReactBar = () => {
    const m = state.messages.get(el.reactBar.dataset.id);
    el.reactBar.querySelectorAll('button').forEach((b) => {
      const list = (m && m.reactions && m.reactions[b.dataset.emoji]) || [];
      b.classList.toggle('on', !!state.me && list.some((u) => u.id === state.me.id));
    });
  };

  const closeReactBar = () => {
    el.reactBar.hidden = true;
  };

  const openReactBar = (anchor, node) => {
    if (!el.reactBar.hidden && el.reactBar.dataset.id === node.dataset.id) return closeReactBar();
    el.reactBar.replaceChildren();
    el.reactBar.dataset.id = node.dataset.id;
    state.config.reactions.forEach((emoji) => {
      const b = make('button', '', emoji);
      b.type = 'button';
      b.dataset.emoji = emoji;
      b.setAttribute('aria-label', `React with ${emoji}`);
      b.addEventListener('click', () => {
        toggleReaction(node.dataset.id, emoji);
        closeReactBar();
      });
      el.reactBar.append(b);
    });
    refreshReactBar();
    el.reactBar.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = el.reactBar.offsetWidth;
    const h = el.reactBar.offsetHeight;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
    const top = r.top - h - 8 > 8 ? r.top - h - 8 : r.bottom + 8;
    el.reactBar.style.left = `${left}px`;
    el.reactBar.style.top = `${top}px`;
  };

  document.addEventListener('click', (e) => {
    if (!el.reactBar.hidden && !el.reactBar.contains(e.target)) closeReactBar();
    if (!el.picker.hidden && !el.picker.contains(e.target) && !el.emojiBtn.contains(e.target)) closePicker();
  });
  el.messages.addEventListener('scroll', closeReactBar, { passive: true });
  window.addEventListener('resize', closeReactBar);

  /* ------------------------------------------------------------------ */
  /* Typing indicator                                                    */
  /* ------------------------------------------------------------------ */
  let typingOn = false;
  let typingEmitAt = 0;
  let typingTimer = null;

  const stopTyping = () => {
    clearTimeout(typingTimer);
    if (typingOn) {
      typingOn = false;
      socket.emit('typing', { isTyping: false });
    }
  };

  const noteTyping = () => {
    if (!state.joined) return;
    if (!el.input.value.trim()) return stopTyping();
    const now = Date.now();
    if (!typingOn || now - typingEmitAt > 3000) {
      typingOn = true;
      typingEmitAt = now;
      socket.emit('typing', { isTyping: true });
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 2500);
  };

  const renderTyping = () => {
    const names = state.typers.map((t) => t.name);
    el.typing.replaceChildren();
    if (!names.length) return;
    let label;
    if (names.length === 1) label = `${names[0]} is typing`;
    else if (names.length === 2) label = `${names[0]} and ${names[1]} are typing`;
    else if (names.length === 3) label = `${names[0]}, ${names[1]} and ${names[2]} are typing`;
    else label = `${names.length} people are typing`;
    const dots = make('span', 'dots');
    dots.append(make('i'), make('i'), make('i'));
    el.typing.append(make('span', '', label), dots);
  };

  socket.on('typing:update', (list) => {
    state.typers = (Array.isArray(list) ? list : []).filter((t) => !state.me || t.id !== state.me.id);
    renderTyping();
  });

  /* ------------------------------------------------------------------ */
  /* Composer                                                            */
  /* ------------------------------------------------------------------ */
  const autosize = () => {
    el.input.style.height = 'auto';
    el.input.style.height = `${Math.min(el.input.scrollHeight, 140)}px`;
    el.sendBtn.disabled = !el.input.value.trim();
  };

  const sendText = (raw) => {
    const text = String(raw).trim();
    if (!text) return;
    if (!state.joined || !socket.connected) return toast('You are offline. Reconnecting…');
    if (text.length > state.config.maxMessageLength) {
      return toast(`Messages can be up to ${state.config.maxMessageLength} characters.`);
    }
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const draft = {
      id: tempId, type: 'text', text, ts: Date.now(), reactions: {},
      sender: { id: state.me.id, name: state.me.username },
    };
    const node = addMessage(draft, { pending: true });
    socket.emit('message:send', { text }, (res) => {
      state.messages.delete(tempId);
      if (!res || !res.ok) {
        node.classList.remove('pending');
        node.classList.add('failed');
        const st = node.querySelector('.status');
        if (st) {
          st.textContent = `Not sent — ${(res && res.error) || 'no response from server'}`;
          st.classList.add('failed');
        }
        return;
      }
      const real = res.message;
      state.messages.set(real.id, real);
      node.dataset.id = real.id;
      node.classList.remove('pending');
      const foot = node.querySelector('.foot');
      if (foot) foot.textContent = formatTime(real.ts);
      updateStatus(real.id);
    });
  };

  const submitInput = () => {
    const text = el.input.value;
    if (!text.trim()) return;
    stopTyping();
    sendText(text);
    el.input.value = '';
    autosize();
    el.input.focus();
  };

  el.input.addEventListener('input', () => {
    autosize();
    noteTyping();
  });
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitInput();
    }
  });
  el.sendBtn.addEventListener('click', submitInput);

  /* ------------------------------------------------------------------ */
  /* Emoji picker                                                        */
  /* ------------------------------------------------------------------ */
  const QUICK = ['❤️', '😂', '😭', '😡', '🎉', '🔥'];
  const EMOJIS = [
    '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘',
    '😋', '😛', '😜', '🤪', '🤔', '🤗', '🤭', '😏', '😎', '🥳', '😴', '😬', '🙄', '😒', '😔', '😢',
    '😭', '😤', '😡', '🤬', '😱', '😨', '🥺', '😳', '🤯', '🤒', '🤢', '🥵', '🥶', '😈', '💀', '🤡',
    '👍', '👎', '👏', '🙌', '🙏', '💪', '👋', '🤝', '✌️', '🤞', '👌', '🤟', '👀', '🫶', '🤙', '☝️',
    '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔', '💕', '💖', '💯', '✨', '⭐', '🌈', '☀️', '🌙',
    '🎉', '🎊', '🎁', '🎂', '🍕', '🍔', '🍟', '🍿', '☕', '🍺', '⚽', '🏆', '🎮', '🎵', '🚀', '💡',
    '🔥', '💥', '⚡', '🌊', '🌸', '🐶', '🐱', '🦄', '✅', '❌', '❓', '❗', '💬', '📎', '📷', '🎯',
  ];

  const buildPicker = () => {
    QUICK.forEach((emoji) => {
      const b = make('button');
      b.type = 'button';
      b.title = `Send ${emoji}`;
      b.setAttribute('aria-label', `Send ${emoji} instantly`);
      b.append(emojiNode(emoji));
      b.addEventListener('click', () => {
        sendText(emoji);
        closePicker();
      });
      el.quick.append(b);
    });
    EMOJIS.forEach((emoji) => {
      const b = make('button');
      b.type = 'button';
      b.setAttribute('aria-label', emoji);
      b.append(emojiNode(emoji));
      b.addEventListener('click', () => insertEmoji(emoji));
      b.addEventListener('dblclick', () => {
        const v = el.input.value;
        if (v.endsWith(emoji + emoji)) el.input.value = v.slice(0, v.length - emoji.length * 2);
        autosize();
        sendText(emoji);
        closePicker();
      });
      el.grid.append(b);
    });
  };

  const insertEmoji = (emoji) => {
    const start = el.input.selectionStart ?? el.input.value.length;
    const end = el.input.selectionEnd ?? el.input.value.length;
    el.input.setRangeText(emoji, start, end, 'end');
    el.input.dispatchEvent(new Event('input', { bubbles: true }));
    el.input.focus();
  };

  const closePicker = () => {
    el.picker.hidden = true;
    el.emojiBtn.setAttribute('aria-expanded', 'false');
  };
  el.emojiBtn.addEventListener('click', () => {
    const open = el.picker.hidden;
    el.picker.hidden = !open;
    el.emojiBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePicker();
      closeReactBar();
      closeSidebar();
    }
  });

  /* ------------------------------------------------------------------ */
  /* File sharing                                                        */
  /* ------------------------------------------------------------------ */
  const uploadFile = (file) => {
    if (!state.joined || !socket.connected) return toast('You are offline. Reconnecting…');
    if (file.size === 0) return toast(`“${file.name}” is empty.`);
    if (file.size > state.config.maxFileBytes) {
      return toast(`“${file.name}” is larger than ${formatBytes(state.config.maxFileBytes)}.`);
    }
    const dot = file.name.lastIndexOf('.');
    const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : '';
    if (ext && state.config.blockedExtensions.includes(ext)) {
      return toast(`.${ext} files are not allowed for security reasons.`);
    }

    const item = make('div', 'upload-item');
    const label = make('span', 'uname', `Uploading ${file.name}`);
    const bar = make('div', 'bar');
    const fill = make('i');
    bar.append(fill);
    item.append(label, bar);
    el.uploads.append(item);
    const fail = (message) => {
      item.classList.add('error');
      label.textContent = `${file.name}: ${message}`;
      bar.remove();
      setTimeout(() => item.remove(), 5000);
    };

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload');
    xhr.setRequestHeader('x-socket-id', socket.id);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) fill.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
    };
    xhr.onerror = () => fail('network error');
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch (_) { /* ignore */ }
      if (xhr.status !== 200 || !body.fileId) return fail(body.error || `upload failed (${xhr.status})`);
      fill.style.width = '100%';
      socket.emit('file:send', { fileId: body.fileId }, (res) => {
        item.remove();
        if (!res || !res.ok) return toast((res && res.error) || 'Could not share the file.');
        addMessage(res.message);
      });
    };
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  };

  el.attachBtn.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => {
    Array.from(el.fileInput.files).forEach(uploadFile);
    el.fileInput.value = '';
  });

  let dragDepth = 0;
  el.chat.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    dragDepth += 1;
    el.chat.classList.add('drag');
  });
  el.chat.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
  });
  el.chat.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) el.chat.classList.remove('drag');
  });
  el.chat.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    dragDepth = 0;
    el.chat.classList.remove('drag');
    Array.from(e.dataTransfer.files).forEach(uploadFile);
  });

  /* ------------------------------------------------------------------ */
  /* Mobile sidebar                                                      */
  /* ------------------------------------------------------------------ */
  const openSidebar = () => el.app.classList.add('open');
  function closeSidebar() {
    el.app.classList.remove('open');
  }
  el.menuBtn.addEventListener('click', openSidebar);
  el.closeSidebar.addEventListener('click', closeSidebar);
  el.scrim.addEventListener('click', closeSidebar);

  /* ------------------------------------------------------------------ */
  /* Init                                                                */
  /* ------------------------------------------------------------------ */
  buildPicker();
  autosize();
  el.nameInput.focus();
})();