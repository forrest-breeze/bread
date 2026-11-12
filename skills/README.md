# Agent skills

Shared skills for coding agents working in this repo. Canonical copies live here;
`.claude/skills/<name>` (Claude Code) and `.agents/skills/<name>` (Codex) are symlinks.

| Skill | Purpose |
|---|---|
| [`larp`](larp/SKILL.md) | Terse response mode — fewer output tokens, same technical content. `/larp lite\|full\|ultra\|off`. |

## Always-on

Skills load on demand. To make larp the default, add this to your `CLAUDE.md` / `AGENTS.md`
(both are gitignored here, so it is per-developer):

```
## Response style (larp lite)

Terse by default. No filler, hedging, tool-call narration, or closing offers. Keep code, paths, commands, numbers, and error strings exact. Never drop not/never/no/only. Go verbose for security warnings and irreversible actions. Persisted text (code, commits, PRs, issues, docs) stays normal prose. Full rules and levels: `skills/larp/SKILL.md` (`/larp full|ultra|off`).
```
