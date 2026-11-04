# AGENTS.md

Repo for pi extensions: one npm package each, published to GitHub Packages.
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
   by the server, not by convention, and a merge waits for a green `check` job. Work happens
   on the branch and arrives by pull request; merging is an action of its own, so it needs its
   own approval under rule 2.

   **Opening a pull request is the user's click; the agent's part ends with a link and a
   description.** After the push, hand over the compare URL, plus the text to paste — the
   title is one line about what changes, the body is the reason, which is already written in
   the commit message:

   ```text
   https://github.com/shushanskii/pi-extensions/compare/main...<branch>
   ```

   `gh` is installed here and its token could open the pull request with `gh pr create`, so
   leaving the click to the user is a policy, not a missing permission.

5. **`AGENTS.md` is edited by the owner.** An agent never adds to or tidies this file on its
   own, not even when a merge has made a paragraph wrong: it shows the diff and names the
   paragraph that broke. It types an edit only on the owner's explicit instruction in that
   session — the owner decides, the agent transcribes. A lesson about the agent's own habits
   belongs in its own memory, not in every prompt of this repository.

## Before proposing a change

```bash
npm run check    # types, then Biome, then fallow
```

`check` is the sum of the scripts beside it in the root `package.json`, one per tool, so a
failure names the tool that said it and a clone of CI cannot drift from a local run. The
scripts say what runs; this says what they do not:

- pi loads TypeScript without type-checking it, so a type error is invisible in every run
  until `typecheck` runs; an agent that loaded the package in pi has proven nothing about
  its types. The root `package.json` pins the pi release the types come from; a check
  against a drifted pin means nothing.
- Biome is strict on purpose: every stable rule is an error and `lint` passes
  `--error-on-warnings`, so a rule downgraded later still fails the run. A format diff is
  drift, not taste — tabs, double quotes, 120 columns are the code as it is. Three settings
  carry weight and have no comment beside them in `biome.json`: `vcs.useIgnoreFile` is what
  makes `.gitignore` mean anything to Biome; `package-lock.json` is excluded because npm
  would undo any formatting of it on the next install; `!**/docs` is excluded because Biome
  reformats Markdown, tabs inside fenced code blocks included, which would rewrite a
  translation away from the upstream it mirrors.
- A rule that cannot be satisfied at the level of a whole repository is switched off in
  `biome.json`, its reason in the commit that switched it off. A rule impossible only
  _here_ — a handler pi types as Promise-returning and this one has nothing to wait for —
  takes a `// biome-ignore` line carrying the reason. Never both: a rule switched off
  globally to dodge one call site silences every future call site too.
- `any` is not tolerated, and `unknown` is not a way to keep an untyped value unnamed:
  pi's own exported types (`SessionEntry`, `CompactionEntry`, `SessionBeforeCompactEvent`)
  cover session shapes, and a value from outside — a JSON body, a message union — is read
  field by field through small guards. The linter stays green for `unknown` plus a cast
  over the whole payload, and that is the dodge, not the fix: a cast covers one field and
  says so (`reasoning: "off"` in next-prompt).
- `fallow report` prints duplication and complexity as advice, never as a failure; both are
  the shape of this repository, not defects in it.

There are no tests and no linter beyond Biome. A change to a package is verified by loading
it:

```bash
pi --no-extensions -e ./packages/<name>
```

## A package imports nothing from another package

Every `packages/<name>` is one fallow zone in `.fallowrc.json` and every zone allows nothing,
which is what turns "independent packages" from an intention into a check: importing
`../pi-speak/index.ts` or `@shushanskii/pi-speak` from another package fails `npm run analyze`,
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

Copy a neighbouring `package.json` rather than writing one: `@shushanskii/<name>`, the
`pi-package` keyword, `license: UNLICENSED`, a `files` list naming exactly `index.ts`,
`README.md` and the config example, `pi.extensions: ["./index.ts"]`, the three
`peerDependencies` at `"*"` (the packages come from the pi that loads this one, so nothing
here may install a second copy), `publishConfig.registry` pointing at GitHub Packages, and
the `repository` field naming this repository, which is how the registry links a published
package to it and inherits its permissions. The scope is part of the same constraint: this
registry routes a package by its scope, so only `@shushanskii` can be published from here.
`tsconfig.json` picks the directory up by glob; the root `package.json` needs nothing.

`README.md` stays a shop window — what it is, install and remove, a pointer to the config
example. The command named after the package (`/web`, `/image`, `/speak`, `/suggest`) is
where a package says what is in force, and where a path can be proved without a model call.

## The why lives in the file header

Design, the alternatives rejected, the measurements and the failure modes go in the header
comment of `index.ts`, not in `README.md` and not in a document beside it: `files` ships
`index.ts`, so the reasoning travels with the code and cannot drift from it. A change that
makes the header wrong is not finished. New measurements belong there too, with the numbers
that produced them and the machine they were taken on.

## Comments are opt-in

An agent adds a comment only where it records a constraint, an invariant, a workaround or a
measurement the next reader cannot derive from the file — inline, in one literal line, with
no metaphor the code does not already use. The why of a whole package lives in the header, not
scattered through its body. A comment over code the change did not touch is not an
improvement; a comment explaining what the code does is a rename or a split waiting to
happen. Comments are read back by the next agent run as facts, so one that goes stale is
worse than none.

## Config and secrets

A package reads `~/.pi/agent/<name>.json`, every key optional, the defaults being the
working ones, and ships `<name>.json.example` of its shape. The config is read on each use,
not once at load, and the slash command carries `reload` — so an edit needs no restart.

A token never lives in the config, in argv, or in the environment: on this OS every process
of the same user reads them, and a config gets pasted into a chat. A token lives in a file
at `0600` which the config names, and is read when it is needed. Secrets stay out of this
repository: no token, no token file, and no endpoint beyond the public hosts the defaults
already name.
