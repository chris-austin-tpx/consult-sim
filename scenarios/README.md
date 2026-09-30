# Scenarios

Each `*.json` file in this folder is one playable scenario (level). The server loads them all at startup. If a file is invalid, the server logs why and skips it, and the other scenarios still load. `characters.json` holds the reusable Project Phoenix cast (Jenny, David with Satish, Priya, Ben), which scenarios reference with `ref`.

To add a scenario, drop a new file in this folder and restart the server. Run `npm test` to check that every file is valid.

## Format

```jsonc
{
  "id": "phoenix-slipping",          // kebab-case; must match the file name
  "title": "Slipping Behind",
  "difficulty": 2,                    // 1–5, shown as stars and used for ordering
  "summary": "One or two sentences for the level card.",
  "projectName": "Project Phoenix",
  "phase": "Build — Week 12 of 20",   // shown in the status panel and given to the characters

  "briefing": {
    "llm": "What the characters know about the project and the current situation.",
    "display": {                      // what the player sees on the briefing screen
      "objectives": ["..."],
      "timeline": [{ "when": "Weeks 1–3", "what": "Discovery" }],
      "deadlineNote": "⚠ ...",
      "risks": [{ "level": "high", "text": "..." }]   // high | medium | low
    }
  },

  "rules": {                          // all optional; defaults shown
    "winThreshold": 80,               // confidence needed to win a stakeholder
    "loseThreshold": 30,              // falling to or below this (after grace) loses them
    "lossGraceMessages": 2,           // messages before a loss can happen
    "deltaClamp": { "min": -15, "max": 25 }   // how far one message can move confidence
  },

  "openRisks": ["Short risk lines for the status panel"],

  "stakeholders": [
    {
      "ref": "jenny",                 // base persona from characters.json…
      "startConfidence": 35,          // …with any fields overridden
      "situation": "Private: what's happened to this person and how they feel walking in.",
      "opener": "Their first line.",
      "winLine": "...", "loseLine": "...",
      "card": { "note": "Shown on the stakeholder card." }
    },
    { "ref": "ben" }
  ],

  "events": [                         // optional mid-round twists
    {
      "id": "go-live-moved",
      "afterTurns": 6,                // fires after this many player messages, across all conversations
      "text": "📣 What the player sees, in every conversation.",
      "briefingAddendum": "What the characters are told from then on.",
      "confidenceShift": -10,         // optional: applied to every still-active client
      "reactions": { "jenny": "Jenny's immediate reaction, in her conversation." }
    }
  ]
}
```

### Characters outside Project Phoenix

A stakeholder without a `ref` must define the whole persona inline. The required fields are:

- `key`, `fullName`, `role`, `pronoun`, `personality`, `privateMotivation`, `styleNotes`, `opener`
- For scored stakeholders, also `winLine`, `loseLine`, `insultLine` and `startConfidence`

A stakeholder with `"noScoring": true` has an unscored, supportive check-in, like Ben's. It needs no scoring fields. Optional fields are `initials`, `avatarClass`, `replies` (canned fallback lines), `technicalFocus` and `colleague` (see David in `characters.json`).

Private fields (`privateMotivation`, `styleNotes`, `situation`, `technicalFocus`, `colleague`, `briefingAddendum`, and `briefing.llm`) are never sent to the browser.

## Making a scenario harder

Use these levers, roughly from gentlest to harshest:

| Lever | Effect |
|---|---|
| Lower `startConfidence` | Stakeholders start further from winning and closer to losing. |
| A hostile `situation` and `opener` | The characters walk in angry, blindsided or with a hidden grievance. |
| `events` | The situation changes mid-conversation. Combine with `confidenceShift` for a knock. |
| Higher `winThreshold` | The player needs a more complete win. |
| Smaller `deltaClamp.max` | Even excellent answers win less, so the player needs more good turns in a row. |
| Lower `lossGraceMessages` | Less room to recover from a bad opening. |

As a rough guide:

- ★ is the original kickoff.
- ★★ adds one serious problem.
- ★★★ adds a twist that lands mid-round.
- ★★★★ is a crisis with low trust and tighter rules.
- ★★★★★ is reserved for the toughest real-world stories.

## Drafting a scenario from a real story

Employees can write up a real situation using `stories/TEMPLATE.md`. Then run:

```bash
npm run draft-scenario -- scenarios/stories/my-story.md
```

This asks Gemini to turn the story into a draft scenario at `scenarios/drafts/<id>.json` and reports any validation problems. A person must review the draft before it's published:

1. Check that everything is fictionalised.
2. Check that the difficulty feels right.
3. Delete `_draftNotes`.
4. Move the file into this folder.

Draft files and stories are gitignored, because they may contain details from real engagements.

**Anonymise stories before drafting.** The story text is sent to Gemini.
