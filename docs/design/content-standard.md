# Content standard — round 53

Status: contract for the full-corpus content pass. Author: architect session
(who, by standing rule, does not read the historical content itself; every
item is reviewed and edited by an Opus agent against this standard).

User's brief, verbatim in the parts that matter: *"Go over events. There are
many mistakes and many are inadequate. For example wrong descriptions of
images. Confusing text and so on. The guidance is this — stick close to
Wikipedia. Do not try to rewrite it just for the sake of it. You should have
simplified summary as the first small paragraph and then you can dive a bit
deeper. What I don't want you to do is to write detailed steps there — if
there are steps / phases, they should go into separate steps (like
operations). … For most items 150–250 words should be appropriate, for some
major you can do 500 or more (excluding steps). Many longer term / period
events should become like 'operations', for example Black Death."*

## The register

Wikipedia's, not an essayist's. Neutral, factual, no editorial colour, no
"remarkably", no "would prove to be". Where the agent can consult the actual
Wikipedia article (WebFetch — test reachability once and adapt), stay close
to its framing and emphasis; never copy sentences verbatim (the app is not a
mirror), but do not invent a different framing when Wikipedia's is standard.
Do not rewrite text that already meets the standard — the brief says so
explicitly. Edit what is wrong, confusing, padded, or misweighted; leave
what is right.

## The shape of an article

1. **First paragraph: the simplified summary.** Two to four plain sentences
   a reader who will read nothing else should get: what it was, when, where,
   why it matters. No subclauses stacked three deep.
2. **Then deeper**: background, course, consequence — as prose, in that
   rough order where it fits the subject.
3. **No step-by-step narration in the article.** If the subject has phases,
   campaigns, waves, stages: the article says so in a sentence and the
   PHASES BECOME SAGA STEPS (dated, per docs/design/sagas.md rules 4–5).
   The article's overview and the steps must not duplicate each other.

## Budgets

150–250 words for most items; up to ~500+ for majors (top ranking tier is a
good proxy; judgment allowed). Steps' pages are excluded from the budget.
A person or concept follows the same shape scaled to its weight.

## Images

Every image reference must be checked: the caption/description must describe
THAT image (verify against the Wikipedia summary/Commons metadata if
reachable; if unverifiable, the caption may only claim what the image title
itself supports — no invented detail). Wrong-image or wrong-caption pairs
are exactly the defect the user reported; when in doubt, prefer a plainer
caption over a confident wrong one.

## Saga promotion

Long-period events whose story is phases (Black Death is the named example;
epidemics, migrations, long wars, colonisations, golden ages are the
category) become sagas: real dated steps (year-to-day precision as honest),
each step a page of its own; drawings only where an area/route is already
authored or is straightforward — steps without drawings are legal. The
saga's own span must be the true period. Validator rules apply (steps
acyclic, dated, inside the span).

## Corpus conventions (architect rulings, round 53)

- The `Part of [X](event:x).` opening crumb STANDS wherever the parent
  relation exists — it is navigation, not prose, and it is load-bearing for
  internal linking. Agents who stripped it restore it.
- The closing `More at [Wikipedia](url).` line STANDS corpus-wide — one
  consistent closer beats a per-chunk vote.
- Step dates anchor at MIDDAY, not midnight (5-dp year fractions round a
  midnight anchor into the previous day; the WWII exemplar already uses
  midday). Round-trip every authored date through the app's own calendar
  arithmetic before shipping it.
- Every child-bearing step: the child declares the matching `parent`
  relation, and the step's name equals the child's title verbatim.

## Register rulings (round 55 — from the reader, verbatim intent)

The round-53 pass left a residue of editorialising the reader named
precisely: *"some events have very 'neo liberal' descriptions, for example
Voyages of Christopher Columbus. Try to follow Wikipedia style more
closely. Avoid using mdash and AI writing style. You can literally copy
some text from Wikipedia. Your text should be extremely neutral, with
maybe slight exceptions to genocides, but even there do not focus on
morality (in these cases you can still mention how it's viewed today but
do not dwell on it)."* Therefore:

- **Extreme neutrality.** No moral framing, no "devastating legacy", no
  "at terrible cost", no perspective-taking on behalf of victims or
  perpetrators. State what happened, numbers where sourced, period.
- **Genocides and atrocities**: the facts carry the weight. One sentence
  of how it is viewed/classified today is permitted (e.g. "It is widely
  regarded as a genocide"); no dwelling, no adjectives doing moral work.
- **Wikipedia wording may be copied literally** where it serves — the app
  links every article to its source and ships a CC BY-SA attribution
  notice. Close-following beats creative paraphrase; never invent a
  framing Wikipedia does not have.
- **No em-dashes.** Use commas, parentheses, or separate sentences.
- **No AI register**: no "marked a turning point", "reshaped the
  landscape", "underscored", "highlighted the importance", rule-of-three
  flourishes, or paragraph-final significance claims. If a sentence could
  end a TED talk, delete it.

## What agents must not do

No new items this round (fixing, not growing). No ranking changes. No
relation rework except where a saga promotion naturally links existing
children as steps. No prose in the data files' notes fields — reasoning goes
in the agent's report. Titles change only to correct errors.
