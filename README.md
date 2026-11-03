# Claude Hub

Send instructions to Claude Code from your phone. A worker on the VPS (always on) and on the laptop
(starts at login) picks them up, makes the change, pushes to the default branch, optionally deploys,
and replies in the app. When the laptop starts it also pulls every project folder, so local copies
and local Claude sessions see what happened while you were away.

```
phone app ──▶ GitHub issue (label "hub") ──▶ VPS worker (instant) / laptop worker (after 3 min)
                     ▲                                │
                     └──────── reply + commit links ◀─┘
```

- **Projects** are your GitHub repos with the topic `claude-hub` (add them from the app).
- **Instructions** are issues labelled `hub`. Reply in the app to follow up; replying to a finished
  one reopens it. Only issues written by the repo owner's account are acted on.
- **Status**: waiting → working → done (closed) or needs you (`hub:failed`).
- Machine heartbeats go to a secret gist (`claude-hub-status.md`) that the app reads.

## Pieces

| Path | What it is |
| --- | --- |
| `docs/` | The phone app (static, served by GitHub Pages). Add it to your home screen. |
| `hub/hub.mjs` | The worker. Node 20+, no dependencies. Needs `git` and `claude` on PATH. |
| `hub/hub.config.json` | Per-machine config (not committed). See `hub.config.example.json`. |
| `setup/install-laptop.ps1` | Starts the hub hidden at every Windows login. |
| `setup/install-vps.sh` | Creates the `claude` user, swap and the `claude-hub` systemd service. |
| `setup/set-vps-secrets.ps1` | Saves the GitHub + Claude tokens on the VPS without showing them. |

## Config

```json
{
  "machine": "laptop",
  "claimDelaySeconds": 180,
  "localProjects": { "eclock": "C:/Users/me/Desktop/eclock" },
  "deploy": { "eclock": "sudo /usr/local/sbin/hub-deploy eclock" }
}
```

`localProjects` folders are pulled at login and every 10 minutes, only when they are clean and on a
branch with an upstream; otherwise the hub tells you why it skipped them. Workers never touch
these folders otherwise. They work in their own clones under `~/.claude-hub/work`.

## Useful commands

```sh
node hub/hub.mjs --once     # one poll, then exit
node hub/hub.mjs --sync     # just pull local project folders
journalctl -u claude-hub -f # VPS log
```

Laptop log: `%USERPROFILE%\.claude-hub\hub.log`.
