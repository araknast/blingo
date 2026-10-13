# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Solo developers, invite-only, who point many coding agents at their own repositories at once and
supervise them from yorkle. Their job: hand out work (tasks, plans), watch it land, and step in
only where agents collide — conflicts, failed CI, rejected reviews, ferges.

## Product Purpose

yorkle runs many coding agents on one repository without them stepping on each other. Each agent
(or a human, through a notagent) works on its own fork; finished forks are sorted into bubbles of
forks that touch disjoint files, and a background loop merges each bubble and then neighbouring
bubbles back together. Success: many agents' work reaches one codebase with the human touching
only the genuine conflicts.

## Positioning

Change control by file-disjoint bubbles instead of a branch/PR queue: placement is decided by which
files a fork changed, merges happen continuously in the background, and conflicts are isolated to
bubble pairs that a ferge resolves. The live bubble map is the product's own picture of that state.

## Operating Context

- A desktop browser session kept open while agents run; the Map (`/repos/:r`) is the home view.
- Per-repository tabs: Map, Tasks, Agents (runs and transcripts), Deploy, Skills, Memory, Settings;
  loose forks and bubbles have their own pages with a code and commit browser.
- Tasks work like an issue tracker: filed by hand or planned by a superagent, with dependencies,
  optional approval before merging (`taskApproval`), and agent or notagent kinds.
- Repo settings include each repository's own model API key/provider, CI and reviews, `autoFerge`.
- Humans push to notagent forks with ordinary git.

## Capabilities and Constraints

- Two Workers: **blingo** (backend: API, bubble rules, merge loop, sandboxes) and **yorkle**
  (Svelte 5 UI + a Worker forwarding `/api/*`). API logic belongs in blingo.
- Users see the name **yorkle**; **blingo** is internal/backend only. Keep that split.
- Fixed vocabulary, not to be softened or renamed in UI copy: repository, fork, bubble,
  representative, merged/pending/failed/conflict, locked bubble, ferge, notagent, agent,
  superagent, task, skill, memory.
- Signup needs an invite code and email verification; each repository belongs to its creator.
- Desktop-first. Mobile must not break, but supervising agents is a big-screen job.

## Brand Commitments

- Product name `yorkle`, lowercase, as in the existing wordmark.
- Voice in shipped copy is plain and factual ("Run many coding agents on one repository.").

## Evidence on Hand

- `design.md`: the original bubble/ferge design sketch (product concept, not a visual system).
- `ARCHITECTURE.md`, `README.md`: authoritative mechanics and API.
- `yorkle/app/lib/demo.ts`: the scripted bubble-map demo on the splash page.
- No customers, testimonials, usage numbers, or pricing exist. Do not invent them.

## Product Principles

1. The map is the truth: state the user needs to act on should be visible on the bubble map or one
   click from it.
2. Attention goes to conflicts. Clean merges are background; conflicts, failures and rejections
   are what the human is there for.
3. Say what the system does in its own words; the vocabulary is the model the user learns.
4. Many things move at once; the UI must stay legible at fleet scale (thousands of forks, many
   bubbles), not just in the demo.
