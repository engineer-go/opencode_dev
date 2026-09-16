---
name: skill-authoring
description: Author or update opencode SKILL.md files. Use when capturing a session's learnings as a skill, writing a new skill, or fixing a skill that misled. Covers location, frontmatter, class-level naming, and what not to capture.
---

# Skill Authoring

A skill is the reusable instructions for doing a class of task the most efficient and correct way for the person using the agent: the procedure, the commands and tools that work, the order, the preferences for how the result should look, and the pitfalls that cost time. A future session should be able to load it and produce the right result on the first try.

## Where skills live

- Project: `.opencode/skills/<name>/SKILL.md` (also `skill/`), scanned recursively.
- Global: `~/.config/opencode/skills/<name>/SKILL.md` for learnings that apply across projects.
- Extra locations via `skills.paths` and `skills.urls` in `opencode.json`.
- The file MUST be `SKILL.md` inside a folder named after the skill.

Frontmatter:

```markdown
---
name: my-skill
description: What it does AND when to use it, front-loading the trigger keywords.
---
```

- `name` is required, lowercase hyphen-separated, and matches the folder name.
- `description` is required in practice: cover both what the skill does and when to use it, in third person ("Use when..."). A skill without one is not surfaced to the model.
- Optional: `slash: true` exposes the skill as a slash command.

## Authoring rules

- Class-level, not session-level. Name the class of task (`flutter-deploy`), never a PR number, error string, codename, or a `fix-x` / `debug-y` session artifact.
- Procedure first: the ordered steps with concrete commands, tool calls, and decision points. Attach a lesson to the step it affects.
- A pitfall is a generalizable rule plus one clause of why, imperative. Not a narrative of what happened this session.
- One rule per lesson: search the skill and its support files before adding; strengthen or clarify the existing sentence instead of appending a copy.
- Fix in place: when a skill sentence misled, edit it. Never append "UPDATE: actually...".
- Do not duplicate what the environment already teaches: AGENTS.md files, tool descriptions, framework docs. A skill carries workflow and pitfalls.
- Always-on rules live in `SKILL.md`. Depth needed only sometimes goes in `references/<topic>.md`, named by topic and extended rather than multiplied. Use `templates/<name>` for starter files meant to be copied, and `scripts/<name>` for statically re-runnable actions. Put a one-line pointer in `SKILL.md` to each support file.

## Do not capture

- Environment-dependent failures: missing binaries, fresh-install errors, path mismatches, unconfigured credentials. Capture the fix under a setup or troubleshooting skill, never "this tool does not work".
- Negative claims about tools or features. They harden into refusals long after the problem is fixed.
- Transient errors that resolved. If retrying worked, the lesson is the retry pattern.
- One-off task narratives. Summarizing a PR or analyzing a file is not a class of work.
- Unresolved failures. If no working method was found, do not present dead ends as a "reliable workflow". Say nothing, or capture only an independently-confident working alternative.

## Related

`.opencode/command/capture-skill.md` drives this skill end to end. The shipped `customize-opencode` skill documents user-facing skill config; this skill is about writing the content.
