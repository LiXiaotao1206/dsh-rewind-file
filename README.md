# ⏪ dsh-rewind-file

**Restore workspace files when dsh rewinds a session.**

dsh's `/rewind` (and double-Esc) rewinds the *conversation* only — it forks the
session back to an earlier message but leaves the *files on disk* where they
were. This plugin closes that gap: when you rewind, the files come back too.
It adds **no new commands** — it rides the existing `/rewind`.

## How it works (opencode's mechanism, verbatim)

opencode's `undo`/`redo` is built on a side bare-git repo per project
(`packages/opencode/src/snapshot/index.ts`). This plugin ports that design and
wires it into dsh's rewind:

| opencode primitive | dsh-rewind-file equivalent |
|---|---|
| snapshot repo `data/snapshot/<project>/<hash>` | `$DSH_HOME/rewind-file/<16-hex>/repo.git` |
| `track()` = `git add --all` + `git write-tree` | same — a content-addressed **tree hash** |
| `patch(hash)` = `git diff --cached --name-only <hash>` | same — files changed since a tree |
| `revert(patches)` = `git checkout <tree> -- <file>` + delete-created-after | same — a true rewind deletes what was created after the boundary |

Two hooks do the work:

1. **`session/event` → `step/end`** — capture a snapshot (tree hash) of the
   workspace at the end of every assistant step, keyed by the step's `seq`.
2. **`session/created`** — when the harness publishes a fork/rewind child
   session (`header.parentSession` + `header.seedLength` = the rewind
   boundary), restore the files to the newest snapshot at or before that
   boundary.

The git repo only runs whitelisted, side-effect-free verbs (`init`, `config`,
`add`, `write-tree`, `diff`, `ls-tree`, `checkout`, `read-tree`, …) and never
touches the user's repo, index, or history.

## Behavior

- **No commands, no keybindings, no config to learn** — install and rewind as
  usual; the files follow the conversation.
- Snapshot trees live in git objects; the seq→tree index lives in a small JSON
  file next to the repo. No host storage stack required.
- A rewind restores modified/deleted files **and deletes files created after
  the boundary** — the workspace returns to exactly what it was at the rewind
  point (opencode's true-undo semantics).
- Files are captured at `step/end`, so a rewind to a turn boundary restores to
  the state after the previous turn's last step; a mid-turn tree rewind
  restores to the kept step's end.

## Install

```sh
dsh plugin --profile tui add /path/to/dsh-rewind-file
# restart the profile; then:
dsh --profile tui --dump-config | grep -A8 'id: dsh-rewind-file'
```

Install from npm once published: `dsh plugin --profile tui add dsh-rewind-file`.
Uninstall with `dsh plugin --profile tui remove dsh-rewind-file`; snapshots
stay until you delete `$DSH_HOME/rewind-file`.

## Configuration

Plain config keys in `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `gitBin` | `git` | Git executable |
| `snapshotDir` | `''` | Snapshot root; empty → `$DSH_HOME/rewind-file` (fallback `~/.dsh/rewind-file`) |
| `excludeGlobs` | `['node_modules','.git','.dsh','dist','build']` | Patterns skipped by `git add` (gitignore semantics) |
| `maxSnapshots` | `500` | Snapshots kept per session |

## Safety

- **Whitelisted git verbs only** — a runtime assertion refuses `reset`, `clean`,
  `stash`, `rm` and any destructive verb.
- **Never touches your repo** — a dedicated bare repo holds the trees; your
  `.git`, index and history are untouched.
- **`.gitignore`-aware** — `git add --all` respects the worktree's `.gitignore`
  plus the plugin's `excludeGlobs`.
- **Fails loud, never breaks the harness** — a failed snapshot or restore is
  logged; it never interrupts the rewind or the running tool.

## Why not reuse `dsh-checkpoint-rewind`?

That plugin does three-state checkpoints (workspace + session + config) and
*never deletes* files created after a checkpoint. opencode's `undo` deletes
files created after the snapshot, and this plugin deliberately keeps that
semantic — a rewind returns the workspace to exactly what it was before the
rewound turns, deleted files included.

## License

MIT
