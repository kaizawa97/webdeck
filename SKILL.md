---
name: webdeck
description: "Platform for creating, self-verifying and exporting business presentations (slide decks) with web technology. Always use it when the user names 'webdeck'. Also always use it, even when the word 'presentation' is not spoken, for any request to create, edit or convert slide material ('make a presentation', 'turn this into slides', 'make a deck / talk material / study-group material / proposal', 'turn this into PowerPoint / PPTX / PDF slides', 'presentation / slide deck'; in Japanese: 「プレゼンを作って」「スライドにまとめて」「デッキ/発表資料/登壇資料/勉強会資料/提案資料を作って」「この内容を PowerPoint / PPTX / PDF のスライドにして」), and for questions about how to present or operate the speaker view. Also used for editing, verifying and exporting existing decks (single HTML / PDF / PPTX). Out of scope: producing a single standalone figure or image."
---

# webdeck: an LLM-native presentation platform

Write slides in **plain HTML/CSS/SVG** instead of PowerPoint, self-verify with Playwright,
and export to a single HTML file, PDF or PPTX. Reveal.js 6 (bundled), a custom runtime
(control dock, speaker view), swappable design templates (light/dark modes) and the
verification and export pipeline are **all bundled in this skill**.

Below, `$PP` denotes this skill's directory (`${CLAUDE_SKILL_DIR}` where available).

## Prime directive: ride the platform. Do not reinvent

Slide navigation, the control dock, the speaker view, the projection window, print/PDF
CSS, single-HTML bundling, PPTX conversion, the verification harness: **all of it already
exists**. All you write is the content inside `<section>` (the slides). If you find
yourself writing your own HTML slideshow skeleton, your own navigation UI or hand-written
print CSS, you have left the path. Anything home-made will break one of the distribution
forms (launch from `file://`, single HTML, PDF/PPTX).

## First-time setup (once per machine)

```bash
cd $PP && npm i && npx playwright install chromium
```

Skip if `$PP/node_modules` already exists. If playwright install fails on missing
dependencies, run `npx playwright install --with-deps chromium`.

## Deck creation workflow (always in this order)

### 1. Scaffold

Create the deck **inside the calling project** (recommended: `presentations/<name>/`):

```bash
node $PP/tools/new-deck.mjs presentations/<name> --template <name> --mode light|dark --title "Title"
```

Choose the template by the request and the brand (list and selection guide:
`themes/README.md`; each template's canonical doc: `themes/<name>/README.md`; with a
single template, `--template` may be omitted). The relative reference to the engine, the
theme and the background art are set correctly for you. Keep the paths the scaffold wrote
from then on.

### 2. Derive the norms (from the requester's materials)

Before writing, analyze the **requester's actual materials** (past decks, materials named
as exemplars, the requester's own writing) and derive that requester's norms for wording,
density and structure. The norms in [docs/CONTENT.md](docs/CONTENT.md) are defaults;
**norms derived from the requester always take precedence**. Start from generic
conventions and you will end up redoing everything later: the norms live in the requester,
and the skill holds only an approximation. If no materials exist, say so and start from
the CONTENT.md defaults. (CONTENT.md is written for Japanese-language decks; for decks in
other languages apply the equivalent rule, such as no trailing punctuation in titles,
rather than the Japanese-specific one.)

### 3. Research the material (quotations are the main ingredient)

A slide built only from your own text is always thin. **Even without an explicit
request**, collecting external material that supports each slide's claim is a standard
step:

- **What to collect**: figures and charts from primary sources, official documentation,
  official announcements, papers, real screens. **Quoting the original figure beats
  drawing your own** (CONTENT.md). To explain a tool or a screen, take a real screenshot
  and place it
- **Choose what to quote by the audience's context**: for the same claim, cite the case
  or material closest to the audience's point of view (the one that lands as "this is
  about us" for that industry, organization or role)
- Attach the **source (verbatim, primary-verified) and how to read it (where to look)** to
  every quotation (CONTENT.md)
- Gather candidates per slide, carry them into design (step 4), and record adoption
  decisions and reasons in the decision log
- Where you can talk to the requester, present candidates and let them choose. Where you
  cannot, choose autonomously from the audience context. **A run of text-only slides is a
  sign of failed selection**

### 4. Design (before writing, for every slide)

- For each slide, first write **"the one sentence this slide wants to convey."** Do not
  make a slide whose sentence you cannot state (same for figures: discard a figure whose
  communication goal you cannot state)
- Judge each slide's **temporal structure**: if the core of understanding involves
  sequence / causality / growth or transformation / a loop / pacing, assign an in-slide
  animation ([docs/ANIMATION.md](docs/ANIMATION.md)) or a rendered video
  ([docs/VIDEO.md](docs/VIDEO.md)). Do not add motion to slides that have none (it becomes
  decoration). **Record the decision not to animate, with reasons**
- **Do not silently pass on rendered video**: if a slide would benefit from video (a world
  that a still image cannot show), then where you can talk to the requester, **present it
  as a proposal**; in autonomous production, record the make/skip decision in the log. Not
  every deck needs one, but shipping all-static without considering it is lazy design
- Derive the slide count from speaking time. Lay out the overall map (agenda, chapter
  breaks) first

### 5. Write

Required reading (these two plus the theme's canonical doc):

- **[docs/AUTHORING.md](docs/AUTHORING.md)**: technical rules (canvas coordinate system,
  how to use the theme, fragments, notes, discipline for dynamic content, split editing
  of large decks, prohibitions)
- **[docs/CONTENT.md](docs/CONTENT.md)**: content norms (wording, layout, visualization,
  structure)
- **`themes/<selected template>/README.md`**: the selected template's canonical doc
  (layout classes, components, tokens)
- [docs/LESSONS.md](docs/LESSONS.md): lessons accumulated through production (ignore if
  empty)

The four most important technical rules (details and reasons in AUTHORING.md):

- The canvas is **fixed at 1280×720**. Absolute positioning, flex and grid are all fine;
  coordinates in px
- **Classic `<script>` only** (no ESM), **no external CDN references**
- Do not hard-code colors or fonts; use **the theme's tokens**
- Write real data **as final values in the initial HTML** (screenshots, PDF and PPTX are
  rendered with animation disabled, so values injected later by JS get baked into the
  deliverables as wrong values)

**First-draft gate**: every slide meets the following seven points at the moment it is
written. Do not ship draft quality on the assumption of "fixing it later" (the state that
passes this gate is the first draft):

1. **Surface**: no leftover whitespace (unused information bands). Fill by adding content
   first, then by enlarging fonts
2. **Figures and quotations**: the communication goal can be stated in one sentence. Area
   is proportional to information. **Did you look for a quotable original (figure, chart,
   real screen)?** A slide with only your own text is a signal to go back to research
   (step 3)
3. **Motion**: motion has been considered for slides with temporal structure (the decision
   not to animate is recorded too)
4. **Text**: satisfies the wording norms in CONTENT.md (no poetic register, no punctuation
   in titles, no off-slide wording, no false exhaustiveness)
5. **Sources**: verbatim quotation, verified against the primary source
6. **Verification**: passes verify's machine checks (overflow, overlap, font floor,
   contrast, errors)
7. **Scope**: points 1 to 6 apply to **every slide**, including slides added later, at the
   same time. **A new slide does not inherit past verification and fixes**

### 6. Verification loop (always run it, even unasked: this is the completion condition)

Verification has **three layers**. The overall design, the form of proof and the known
blind spots are set out in [docs/VERIFICATION.md](docs/VERIFICATION.md).

```bash
node $PP/tools/verify.mjs <deckDir>                           # iterate while writing
node $PP/tools/verify.mjs <deckDir> --strict --font-floor=18  # before shipping (warning axes promoted to gates)
```

1. **Machine gate**: the command above. The report and screenshots land in
   `<deckDir>/out/verify/`. **Zero findings is a claim about preconditions, not about
   quality**: the machine sees only the axes that were defined
2. **Your own eyes**: open the screenshots one by one with Read and look. **Look
   especially when findings are zero.** Defects the machine cannot see (awkward line
   breaks, cramped layout, a figure whose intent cannot be read, a sense of wrongness) are
   found only by eye. When you find one, fix it and re-verify before the user has to point
   it out
3. **Independent audit**: when a slide is new, when a requester's comment has been fixed,
   and before shipping, show the deck read-only to someone other than its author (another
   agent). The author knows the intent and cannot test "does it come across" on
   themselves

Slides with animation or video additionally: for in-slide animation, check intermediate
frames with `node $PP/tools/anim-qa.mjs <deckDir> --slide <n> --times <sec,…>`; for video,
extract frames from the shipped mp4 with ffmpeg and inspect them (a static screenshot
cannot show a broken mid-animation state). For a change that should leave static slides
untouched, prove md5 invariance with `--baseline <deck before the change>`.

- **Fix and rerun until findings are zero and the visual check passes. Do not report
  "done" until it passes**
- When it does not converge: do not delete the user's content to force a pass (if a
  deletion becomes necessary, confirm first). When repeated fixes for the same finding stop
  making progress, report the current state with options

### 7. Export (only the requested forms; generate after verify passes)

```bash
node $PP/tools/bundle.mjs <deckDir>                                    # single HTML, full version (with notes; for the speaker)
node $PP/tools/bundle.mjs <deckDir> --strip-notes --dist-title "<name>" # single HTML, distribution version (notes fully removed; for the audience)
node $PP/tools/export-pdf.mjs <deckDir>                                # vector PDF
node $PP/tools/export-pptx.mjs <deckDir>                               # PPTX (pasted images; only on request)
node $PP/tools/export-pptx-editable.mjs <deckDir>                      # PPTX editable in PowerPoint (text boxes/shapes; approximate)
node $PP/tools/find-page.mjs <URL> --selector=<sel> --text=<text>      # locate the source page file from review feedback (e.g. Orca)
node $PP/tools/bundle.mjs <deckDir> --editable                         # one-file HTML that opens in the editor and saves into itself
node $PP/tools/import-single.mjs <file.html> <srcDir> [--write]        # bring edits made in that one file back into src/pages
```

- Deliverables go to `<deckDir>/out/`. **If you edit the deck after exporting, always
  regenerate** (never hand over stale deliverables)
- **Never hand the full version with notes to the audience or a customer.** Speaker notes
  are a deliverable for the speaker; what goes outside is the `--strip-notes` version
  (details: [docs/PRESENTING.md](docs/PRESENTING.md) §5, the four distribution forms)
- bundle has a built-in `file://` smoke test. Do not hand over a deliverable that failed
  it; fix it
- After copying to the destination, confirm byte identity (md5) before saying "delivered"

## Working discipline (iterating with the requester)

- **A comment is the representative of a family**: one comment reports "this kind of
  defect exists." Do not fix the one spot pointed at and stop; sweep the whole deck for
  spots with the same nature, confirm there are no others, then close
- **A comment reports a symptom, not a diagnosis of the cause**: fixing the spots that
  match the wording of the symptom brings the same comment back if the cause is elsewhere.
  Identify the cause, then fix
- **The same comment twice means under-codified norms**: beyond fixing the slide, transfer
  it into the canonical documents and into a machine gate
- **Read between the lines**: the requester's proposed fix is an approximation of "the
  state they want." Do not implement it literally; grasp the intent and deliver the
  highest quality you can (without ignoring what they taught you)
- **Do not confuse delegation with adjudication**: technology choice, layout and specific
  phrasing are delegated (proceed with your best judgment without asking). **Adding or
  removing sections, deleting content and finalizing wording are adjudicated** (never move
  them unilaterally)
- **Verify receipt by measurement**: confirm any "fixed" report (including your own) by
  grep or measurement before moving to the next step
- **Refer to slides by content, not by number**: slide numbers drift with every edit
- **Record positive feedback too**: "this is good" is a protection order. It is
  information for not breaking it in the next change

## Accumulating lessons (this skill grows through production)

When the requester corrects design, phrasing or structure during a session, do not stop
at fixing the deck. Keep a verbatim paired log (what was shown → the correction → the
general rule) on the deck's project side, and **at the end of the session** always propose
the generalizable lessons as an addition to [docs/LESSONS.md](docs/LESSONS.md) (write only
after approval). Operating details are at the top of LESSONS.md.

## Limits of capability

When asked for something this platform cannot do (importing an existing PPTX, a brand
design that no bundled template covers, and so on), **state the limit honestly, propose an
alternative achievable on this platform, and confirm**. A brand design can be added as a
new template by following the contract in `themes/README.md`; instead of an ad hoc
hard-coded patch, propose it as a template addition. For questions about presenting and
operation, read [docs/PRESENTING.md](docs/PRESENTING.md) and answer from it.

## When asked to modify an existing deck

Edit the target `index.html` directly and always run the verification loop of step 6
before reporting completion. For decks run with split fragments (AUTHORING.md §6), follow
the integration and back-sync procedure and confirm zero diff from `fragment.mjs check`.
Nothing under `out/` is edited by hand; it is generated. When you touch a slide with
animation or video, prove with `--baseline` that changes meant to leave static slides
untouched did so.

## Review feedback from Orca (Design Feedback)

When a message arrives as `## Design Feedback: …/index.html` with **URL / Selector / Text / Feedback**, locate the source before editing:
`node $PP/tools/find-page.mjs "<URL>" --selector="<Selector>" --text="<Text>"`.
The shell keeps the current slide's page key in the URL as `?page=<key>` (Orca drops the `#/n` part), so the tool lists that page first.
For page-per-file decks, edit `src/pages/<key>.html` (it lists every deck that shares the page), then run `src/assemble.py`. If nothing matches,
the element is outside the slides (the editor UI itself) — fix the runtime instead.
