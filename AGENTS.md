# AGENTS.md

Repo for pi extensions: one npm package each, published to the forge's npm registry.
[`README.md`](./README.md) is the map; the header comment of each `packages/<name>/index.ts`
carries its design, its measurements and its failure modes, and is the thing to read
before touching that package.

## Rules

1. **A branch and a worktree per change.** No feature and no bugfix is worked on in the
   `main` checkout. Branch `feat/<thing>` or `fix/<thing>`, worktree beside the repository:

   ```bash
   git worktree add ../pi-extensions-fix-token-error -b fix/token-error
   cd ../pi-extensions-fix-token-error && npm ci    # types live in the root node_modules
   ```

   A worktree starts without `node_modules`, so `npm run check` there fails until `npm ci`
   has run. Remove the worktree when the change is merged:
   `git worktree remove ../pi-extensions-fix-token-error`.

2. **Nothing is committed, pushed, tagged or installed without the user's approval for
   that specific action.** Preparing a change, showing the diff, naming the exact command
   — fine. `git commit`, `git push`, `git tag`, and `pi install`/`pi remove`/`pi update` on
   any machine — only on request. Publishing happens by pushing a tag, so a push is not a
   private act here: it can put a version in the registry that every machine then pulls.

3. **English throughout the repository.** Code, comments, doc comments, commit messages,
   branch names, tool descriptions, README and error strings — English. This is the
   operator's second language and the only language a published package's description is
   read in. Russian belongs to the chat and to session notes, never to a file here.

4. **`main` is protected — only a merged pull request changes it.** Direct pushes are refused
   by the server, not by convention — measured with the account this machine pushes with:
   pushing to `main` ends in
   `Forgejo: Not allowed to push to protected branch main` and `pre-receive hook declined`.
   Work happens on the branch and arrives by pull request; merging is an action of its own,
   so it needs its own approval under rule 2.

   **Opening a pull request is the user's click; the agent's part ends with a link and a
   description.** After the push, hand over the compare URL the push itself prints, plus the
   text to paste — the title is one line about what changes, the body is the reason, which is
   already written in the commit message:

   ```text
   https://git.rezolver-zero.com/developer/pi-extensions/compare/main...<branch>
   ```

   Do not spend a push rediscovering the two ways that do not work here. Forgejo 14.0.5
   ignores `merge_request.create` — bare and `=true` alike, a push of a new branch answers
   with nothing but that compare URL — and the tokens held here are scoped to packages, so
   the API refuses even a read:

   ```text
   token does not have at least one of required scope(s): [read:repository]
   ```

   `POST /repos/developer/pi-extensions/pulls` does work, given a token scoped for the
   repository (_Settings → Applications_, not the one `~/.npmrc` uses for packages); ask for
   one rather than assuming it is there.

## Before proposing a change

```bash
npm run check    # types, then Biome, then fallow
```

`check` is the sum of the scripts beside it, one per tool, so a failure says which tool said
it and a clone of CI cannot drift from a local run:

| Script      | Runs                                      | Fails on                                                                                           |
| ----------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `typecheck` | `tsc -p .`                                | a type error                                                                                       |
| `lint`      | `biome check`                             | formatting, lint errors, import order — warnings do not fail it                                    |
| `analyze`   | `fallow architecture`, `fallow dead-code` | a package importing another, an unclassified source file, a cycle, dead code, an unused dependency |
| `report`    | `fallow dupes`, `fallow health`           | nothing: it prints duplication and complexity, which are advisory here                             |
| `fix`       | `biome check --write`                     | nothing — it repairs what Biome can repair                                                         |

pi loads TypeScript without type-checking it, so a type error is invisible in every run
until `typecheck` runs. It is also why the root `package.json` pins the pi release: the
check means nothing if the pinned version drifts from the pi the packages are meant for.

Biome was configured to the code as it already was — tabs, double quotes, 120 columns — so a
format diff means drift, not taste. Two details are load-bearing: `vcs.useIgnoreFile` is on,
which is what makes `.gitignore` mean anything to Biome, and `package-lock.json` is excluded
by name, because npm writes it with two-space indentation and formatting it would be undone
by the next install. A third exclusion, `!**/docs/**`, keeps the translated upstream
guide in `docs/` untouched: Biome reformats Markdown, tabs inside fenced code blocks
included, which would rewrite a translation away from the upstream it mirrors.
`noExplicitAny` stays a warning: pi hands extension code untyped
payloads (`event.messages`, the compaction preparation, a `ctx` read as another shape), and
the gate is not a licence to rewrite those into `unknown` and narrow them back to `any`.

There are no tests and no linter beyond Biome. A change to a package is verified by loading
it:

```bash
pi --no-extensions -e ./packages/<name>
```

## A package imports nothing from another package

Every `packages/<name>` is one fallow zone in `.fallowrc.json` and every zone allows nothing,
which is what turns "independent packages" from an intention into a check: importing
`../pi-speak/index.ts` or `@developer/pi-speak` from another package fails `npm run analyze`,
and the file and the zone it crossed are named. Code that two packages both need becomes a
package of its own, published the same way — not an import.

`coverage.requireAllFiles` is on, so a source file matching no zone fails too. A new
directory at the root needs a zone added, and an eighth package needs its zone and its rule:
forgetting is caught by the gate, not by review.

`fallow report` is not part of `check` on purpose. The duplication it finds is the
registration boilerplate repeated per extension, and the complexity is one long function per
extension; both are the shape of this repository, not defects in it.

## fallow is also an MCP server

`.mcp.json` starts `fallow-mcp` from the local `node_modules`, so `npm ci` gives any clone
the same server the gate uses. The first session in this repository asks to approve it — a
project server stays blocked until it is approved interactively.

`fix_apply` is excluded: it rewrites files, and removing an export from a published package is
a public-API change that belongs in a commit somebody reads. The Fallow Cloud tools are
excluded (this repository is not connected to that account) and the machine-wide `impact_all`
too. `code_execute` is kept behind an approval.

Without the MCP server the CLI answers the same questions: `npx fallow guard <file>` before
an edit lists the rules over that file, `npx fallow trace-export <name>` says why an export
looks unused, and `npx fallow trace-import-path <from> <to>` shows how two modules reach each
other.

## A release is part of the change

A commit that changes `packages/<name>/index.ts` raises `version` in that package's
`package.json` in the same commit — the registry refuses a version that was published once,
so a fix is always a new version. Shipping
is a tag whose name is the package and the version it holds:

```bash
git tag pi-web@1.1.0 && git push origin pi-web@1.1.0
```

The tag pushes through the `publish` job, which type-checks first and fails if the version
in the tag is not the version in the manifest. Never run `npm publish` by hand.

When pi itself moves, raise the pinned versions in the root `package.json` and run
`npm run check` before anything else is changed.

## A new package looks like the other six

Copy a neighbouring `package.json` rather than writing one: `@developer/<name>`, the
`pi-package` keyword, `license: UNLICENSED`, a `files` list naming exactly `index.ts`,
`README.md` and the config example, `pi.extensions: ["./index.ts"]`, the three
`peerDependencies` at `"*"` (the packages come from the pi that loads this one, so nothing
here may install a second copy), and `publishConfig.registry`. `tsconfig.json` picks the
directory up by glob; the root `package.json` needs nothing.

`README.md` stays a shop window — what it is, install and remove, a pointer to the config
example. The command named after the package (`/web`, `/image`, `/speak`, `/suggest`) is
where a package says what is in force, and where a path can be proved without a model call.

## The why lives in the file header

Design, the alternatives rejected, the measurements and the failure modes go in the header
comment of `index.ts`, not in `README.md` and not in a document beside it: `files` ships
`index.ts`, so the reasoning travels with the code and cannot drift from it. A change that
makes the header wrong is not finished. New measurements belong there too, with the numbers
that produced them and the machine they were taken on.

## Config and secrets

A package reads `~/.pi/agent/<name>.json`, every key optional, the defaults being the
working ones, and ships `<name>.json.example` of its shape. The config is read on each use,
not once at load, and the slash command carries `reload` — so an edit needs no restart.

A token never lives in the config, in argv, or in the environment: on this OS every process
of the same user reads them, and a config gets pasted into a chat. A token lives in a file
at `0600` which the config names, and is read when it is needed. Secrets stay out of this
repository: no token, no token file, and no endpoint beyond the public hosts the defaults
already name.
