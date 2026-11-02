# pi-telegram

A private Telegram bot as a second window into the running pi session: a message becomes a
turn in the same session, the answer streams back, and `/new`, `/resume`, `/stop`, `/status`,
`/compact` work from the chat.

```bash
pi install npm:@shushanskii/pi-telegram
pi remove npm:@shushanskii/pi-telegram
```

Config is `~/.pi/agent/telegram.json`, mode 600: `botToken`, and `allowedUserId` — the only
account the bot answers; while it is unset the bot answers nobody.

## A fork

This is [`@qusic/pi-telegram`](https://github.com/Qusic/pi-telegram) 0.2.1 (MIT, Bang Lee —
[`LICENSE`](./LICENSE)), copied into this repository with one change. Upstream's README is
the reference for everything else. `src/` keeps upstream's formatting and is excluded from
Biome, so that a diff against a newer upstream release shows upstream's changes and not ours;
it is type-checked like every other package.

It was chosen by reading: on 2026-10-31 every file of 0.2.1 was read — no dependency, no
child process, one host (`api.telegram.org`), private chats from `allowedUserId` only. The
reasons it beat the alternatives are in the gateway repository's notes on the agents
container (Telegram).

## What changed

**Thinking stays in the session.** Upstream streams the model's thinking into the chat,
marked 💭 and ✏️. Here the live preview carries the text blocks only — the same
`answerText` upstream already used for the final answer — so the chat shows what the model
says, not how it got there. `getMessageText` and its markers are gone.

## Taking a new upstream release

Read the new release's diff before anything else — it runs in pi's process. Then copy its
`src/` over this one, re-apply the change above (`git diff` against the previous copy shows
it), `npm run check`, and publish as `<upstream version>-lab.1`.
