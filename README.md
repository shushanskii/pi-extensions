# pi-extensions

The lab's own pi extensions, one npm package each, published to GitHub Packages
so that every one is installed and removed on its own:

```bash
pi install npm:@shushanskii/pi-web
pi remove  npm:@shushanskii/pi-web
pi update  --extensions          # moves every unpinned package to its latest version
```

| Package                                       | What it does                                                                                            | Config             | Scope                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------- |
| [`pi-web`](packages/pi-web)                   | Crawl4AI as `web_peek`, `web_read`, `web_screenshot`, `web_pdf`; `/web` shows what the model is offered | `web.json`         | global                    |
| [`pi-image`](packages/pi-image)               | qwen-image as `generate_image`; `/image test`                                                           | `image.json`       | global                    |
| [`pi-speak`](packages/pi-speak)               | one spoken Russian sentence at the end of a turn, through piper; `/speak`                               | `tts.json`         | global                    |
| [`next-prompt`](packages/next-prompt)         | the next message guessed as grey ghost text; `/suggest`                                                 | `next-prompt.json` | global                    |
| [`rewrite-compact`](packages/rewrite-compact) | a compaction summary rewritten, not appended to                                                         | —                  | global                    |
| [`remote-gate`](packages/remote-gate)         | a yes/no before a bash call changes a remote host or the network                                        | —                  | global, **not installed** |
| [`read-window`](packages/read-window)         | refuses an unbounded `read` of a large file                                                             | —                  | project: `gw-router`      |

Configs live in `~/.pi/agent/`, every key is optional, and each package carries a
`*.example` of its shape. Secrets stay in the config or in a file it names, never in
this repository.

## Documentation

[`docs/pi-extensions-ru.md`](docs/pi-extensions-ru.md) is a Russian translation of
pi's extensions guide (<https://pi.dev/docs/latest/extensions>), and
[`docs/pi-tui-ru.md`](docs/pi-tui-ru.md) of the terminal UI guide
(<https://pi.dev/docs/latest/tui>), kept in the repository so the Russian-side
terms stay searchable.

## Setting up a machine

The packages are private, so npm needs the scope's registry and a token allowed to
read it. This registry accepts a personal access token **classic** carrying the
`read:packages` scope and refuses a fine-grained token outright, even one that looks
granted — so mint a classic one under _Settings → Developer settings → Personal access
tokens → Tokens (classic)_, ticking no scope but that, and put it in `~/.npmrc`. pi
installs with npm, and npm reads that file:

```ini
@shushanskii:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<classic token, read:packages>
```

Then `pi install npm:@shushanskii/<name>` for each package wanted, and
`pi install -l npm:@shushanskii/read-window` inside `gw-router`. A project package
loads only after pi has been told the project is trusted.

## Changing a package

1. Edit `packages/<name>/index.ts`. Try it without installing:
   `pi --no-extensions -e ./packages/<name>`.
2. `npm install && npm run check` — types against the pi release pinned in the root
   `package.json`, then Biome (format, lint, import order) and fallow (package boundaries,
   dead code). pi loads TypeScript without checking it, so nothing is visible until this
   runs. `npm run report` adds duplication and complexity as advice, never as a failure.
3. Bump `version` in `packages/<name>/package.json`, commit, and tag
   `<name>@<version>` (`git tag pi-web@1.1.0`). Pushing the tag runs the same check and
   publishes that one package; a tag whose version differs from the manifest fails.
4. `pi update npm:@shushanskii/<name>` on each machine.

Publishing needs no secret of its own: `GITHUB_TOKEN` may write packages belonging to
the repository whose workflow runs, and the `repository` field of each manifest is what
links a package to this repository so that write is granted. A version cannot be
published twice: the registry refuses it, so a fix is always a new version.

When pi itself moves to a new release, raise the pinned versions in the root
`package.json` and run the check before anything else.
