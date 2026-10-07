# Huddle – Real-Time Group Chat

A modern group chat built with **Node.js, Express and Socket.IO** and a plain **HTML / CSS / JavaScript** frontend (no build step).

## Features

- **Group messaging** in one common room: sender, timestamp, status (*Sending → Sent → Delivered to N*), auto-scroll, **Enter** to send, **Shift+Enter** for a new line
- **Live typing indicator**: "Naveen is typing…", "Naveen and Rahul are typing…"
- **Animated emoji**: picker with 100+ emoji, one-tap quick send, and CSS animations inside messages
  ❤️ beating · 😂 shaking · 😭 falling tears · 😡 vibrating · 🎉 bouncing · 🔥 flickering
- **Reactions** (❤️ 😂 😍 😢 😡 👍 🔥): click a chip to add or remove yours; counts sync instantly
- **File sharing**: button or drag-and-drop, image previews, type icons (PDF, ZIP, DOC, XLS, PPT, video, audio…), name/size/type and a download button
- **Online users** with green status dots, live count, join/leave notices; each user has a unique Socket.IO id (hover a name)
- **Responsive** glassmorphism dark UI: desktop, tablet and mobile (sidebar becomes a drawer)

## Project structure

```
chat-app/
├── server/
│   ├── server.js        Express + Socket.IO + secure upload handling
│   ├── package.json
│   └── uploads/         Uploaded files are stored here (git-ignored)
├── public/
│   ├── index.html
│   ├── style.css
│   └── script.js
├── test/chat.test.js    Automated integration tests
├── .env.example
├── package.json
└── README.md
```

## Requirements

Node.js **18 or newer** (check with `node -v`).

## Install and run

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

Optional configuration: copy `.env.example` to `.env` and change `PORT`, `MAX_FILE_SIZE_MB`, etc.
For auto-restart while developing, use `npm run dev`.

## Test real-time messaging

1. Start the server and open `http://localhost:3000` in **two or more browser tabs** (or windows, or another device on your network at `http://<your-computer-ip>:3000`).
2. In each tab pick a different username (for example *Naveen* and *Rahul*). Empty or duplicate names are rejected.
3. Type in one tab: the other tab shows **"Naveen is typing…"**. Press **Enter** and the message appears instantly everywhere; the sender's status changes to **Delivered to 1**.
4. Open the 😊 picker: tap an emoji from the **top row** to send it instantly, or send ❤️ 😂 😭 😡 🎉 🔥 inside a sentence and watch them animate.
5. Hover a message and click the reaction button, then pick an emoji. Click your chip again to remove it.
6. Click the 📎 button (or drag a file onto the chat). Images show a preview; everything has a download button.
7. Close a tab: the others see **"… left the room"** and the online count drops.

Run the automated checks with `npm test` (starts a temporary server and drives several Socket.IO clients through join, typing, messages, reactions, uploads and security cases).

## Socket.IO events

| Event (client → server) | Purpose |
| --- | --- |
| `user:join` `{username}` | Join the room (acknowledged with user list, history and config) |
| `message:send` `{text}` | Send a text message |
| `file:send` `{fileId}` | Share a file previously uploaded via `POST /upload` |
| `typing` `{isTyping}` | Start/stop typing |
| `reaction:toggle` `{messageId, emoji}` | Add or remove your reaction |
| `message:received` `{id}` | Delivery receipt (powers *Delivered*) |

| Event (server → clients) | Purpose |
| --- | --- |
| `message:new`, `message:status` | New message / delivery status for the sender |
| `typing:update` | Who is typing right now |
| `reaction:update` | Full reaction state for one message |
| `users:update`, `user:joined`, `user:left` | Online list and join/leave notices |

HTTP: `POST /upload` (multipart field `file`, header `x-socket-id`), `GET /uploads/:name`, `GET /health`.

## Security notes

- Uploads require a connected, joined user; size limit is configurable (default 25 MB).
- Executable types (`.exe`, `.bat`, `.sh`, `.jar`, …) are rejected.
- Files are stored under random names; the original name is sanitised and only used for display.
- Only plain raster images (png, jpg, gif, webp, bmp, avif) are served inline. Everything else is a forced download, and all uploads are sent with `nosniff` and a sandboxing Content-Security-Policy.
- A file can only be shared by the user who uploaded it, once.
- Message length, usernames and reaction emoji are validated on the server; per-socket rate limits apply.
- All user content is rendered with `textContent`, never `innerHTML`, so it can't inject markup.
- Uploaded files are deleted after `UPLOAD_RETENTION_HOURS` (default 24).

## Notes and limits

- Messages and users live **in memory** (last 200 messages are replayed to new joiners). Restarting the server clears the chat. For production, add a database and a Socket.IO adapter (e.g. Redis) to scale beyond one process.
- There are no accounts: usernames are claimed only while online.
- The page loads the *Manrope* font from Google Fonts; offline it falls back to system fonts.

## Troubleshooting

- **Port already in use**: set another `PORT` in `.env`.
- **Upload says "Join the chat first"**: the connection dropped; wait for "Reconnecting…" to disappear and retry.
- **Can't reach it from your phone**: allow Node through your firewall and use your computer's LAN IP.
"# chat-appp" 
"# chat-app" 
