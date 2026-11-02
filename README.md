# webdeck: an LLM-native presentation platform (Agent Skill)

A platform for building business presentations with **web technology** instead of
PowerPoint. An LLM agent writes slides in plain HTML/CSS/SVG, self-corrects through a
screenshot-driven verification loop, and exports to a single HTML file, PDF or PPTX.
The whole repository is one **Agent Skill** (entry point: [SKILL.md](SKILL.md)).

- Slides are plain HTML/CSS/SVG. Edit, reload, done (no build step per deck)
- Fixed 1280×720 canvas. Template-style themes (swappable and extensible)
- Reveal.js 6 bundled, plus a custom runtime (control dock, speaker view, thumbnail rail)
- Verification with Playwright (screenshots plus overflow and contrast checks) and an export pipeline

## Install

Clone into your user-scoped skills directory and any project can trigger it with
"make me a presentation":

```bash
git clone https://github.com/kaizawa97/webdeck.git ~/.claude/skills/webdeck
cd ~/.claude/skills/webdeck && npm i && npx playwright install chromium
```

Any agent that understands the SKILL.md format (Claude Code, Codex and others) can use it
as is. Decks are generated under `presentations/<name>/` in the calling project, and the
reference back to the engine is resolved automatically as a relative path
(`tools/new-deck.mjs`).

## Division of labor: SKILL.md and README.md

- **[SKILL.md](SKILL.md)** is for the LLM agent. It carries only the "necessary and
  sufficient contract" handed over when the skill fires: workflow, verification duties,
  prohibitions.
- **README.md (this file)** is for humans: what the skill is, how it is laid out, how to
  grow it, and what to watch when maintaining it.

## Directory layout

| Path | Contents |
|---|---|
| `SKILL.md` | Instructions to the agent (the skill's entry point) |
| `runtime/` | The undercarriage. Reveal.js 6.0.1 pinned under `vendor/`, plus `shell.js` / `shell.css` (standard config, control dock, speaker-view extensions, aspect-ratio lock). Rarely touched |
| `themes/<name>/` | Templates (design packages): design tokens, layout classes, components, background art, and the `starter/` scaffold for new decks (copied and path-resolved by new-deck). Contract: `themes/README.md`; each theme's canonical doc: `themes/<name>/README.md`. Bundled: `aws` (AWS brand, light/dark) and `sumi` (a general-purpose template in kinari paper × sumi ink × gunjō ultramarine, adapted from webpaper, CSS only) |
| `tools/` | The pipeline (Node + Playwright): `new-deck` (scaffold) / `verify` (verification) / `bundle` (single HTML) / `export-pdf` / `export-pptx` |
| `docs/` | `AUTHORING.md` (technical rules) / `CONTENT.md` (content norms: wording, layout, diagrams, structure) / `ANIMATION.md` (in-slide animation) / `VIDEO.md` (rendered-video pipeline) / `VERIFICATION.md` (the canonical text on verification) / `PRESENTING.md` (presenting and distribution) / `LESSONS.md` (lessons accumulated through production) |
| `evals/` | Test prompts and pass criteria for evaluating the skill |

All documents under `docs/` and `themes/` are written in Japanese.

## Growing the skill through use

The defaults for content norms (wording, layout, diagrams, structure) live in
**`docs/CONTENT.md`**. It is not a fixed style manual but a body of guidance grown by
generalizing feedback from production sessions, and **norms derived from the requester's
own materials always take precedence** (the derivation step is workflow step 2 in
SKILL.md). To grow it:

1. Build real decks with this skill (the requester directs and reviews)
2. Keep the verbatim feedback log on the deck's project side; distill only what
   generalizes into **`docs/LESSONS.md`** (the agent proposes wording, the requester
   approves, then it is appended)
3. When the same lesson recurs, promote it: spell it out in the canonical documents
   (CONTENT / ANIMATION / VIDEO / VERIFICATION) and turn it into a machine gate in verify

What SKILL.md enforces is the standard and the quality process (reuse the platform, the
first-draft gate, the verification loop, the health of the deliverables). The requester's
own aesthetic judgment is carried by norm derivation and LESSONS.

## Maintenance notes

- To change verification or export behavior, edit `tools/`; for the control UI, edit
  `runtime/shell.js`. `runtime/vendor/` is the pinned Reveal.js and is never modified
- Regression tests for the skill: `evals/evals.json` holds test prompts and pass
  criteria. Run them through skill-creator's evaluation flow (with/without comparison
  plus scoring)
