# V04-004 — the worktree is shared, and that is a limit on what any of this evidence can claim

**Severity: process. It does not change a verdict; it changes what a verdict is worth.**

## What was observed

Three separate things in one worktree that this campaign did not create, plus one that destroyed
evidence mid-run:

1. **A worktree at `/Volumes/SSD/v04-verify`** (detached HEAD at `8f324ea`) — a path none of this
   campaign's scripts use. `verify:mutation` is told to build `$(dirname "$REPO")/verify`, which is
   `/Volumes/SSD/verify`, and the runner refused to proceed precisely because *some* `../verify`
   already existed and a snapshot taken over another campaign's fault is a snapshot of the wrong tree.
2. **`tmp/cloudflare-deploy/`**, a worktree nested inside the repository on `codex/deployment-runbook`,
   being written to continuously — which is where the `tmp/cloudflare-*` file activity came from.
3. **`docs/verification/runs/.../03-p0-evidence-map.md`**, an untracked 279-line deliverable of work
   item 3, present in the run directory before this campaign wrote it. It is good work and this
   campaign adopted and corrected it rather than duplicating it — but it was not written here.
4. **`target/` deleted mid-run.** The system volume had been at 98% with 326 MiB free, and `target/`
   held 28 GB. Something reclaimed that space, taking `$REPO/target/v04-logs` — this campaign's
   evidence directory — with it, while a gate was running.

## Why the fourth one is the one that matters

Items 1–3 are someone else's work and are only a problem because two agents would be attributing
results to each other. Item 4 is a **verification** problem, and it is the same defect twice: a
harness that loses its own evidence cannot show what happened to it. The first fix moved the logs off
`/tmp`; the second moved them out of `target/`. Both times the loss was caused by something entirely
reasonable happening to a directory the evidence happened to live in.

That is not a bad-luck story, it is a design error: **the evidence was stored somewhere a routine
operation could reclaim.** A release record's logs belong outside every directory the toolchain owns.
They now live in `/Volumes/SSD/v04-logs`, a sibling of the repository.

## What this campaign's evidence can and cannot claim

**Can:** the gates whose per-gate logs exist in `/Volumes/SSD/v04-logs`, each recorded with its own exit
code and its own log, all run sequentially with the supervisor chain settled between groups. The
measurements inside them are real.

**Cannot:** that `main` was untouched throughout. It was not — a concurrent instance committed
`03-p0-evidence-map.md`'s subject matter, and `main` advanced by that work. The pin rule this campaign
wrote ("the product tree must not move") was checked and **held for product files** — every commit in
this campaign's series touches `docs/verification/` or a named product repair, and the candidate
re-pin is recorded. But the *worktree* was shared, so "the tree was clean when I started the gate" is
not a claim this campaign can make about anything outside its own files.

## The honest consequence for the release verdict

A release decision that leans on a shared, concurrently-modified working tree is a decision made on
partially-observed inputs. The mitigations actually in place are:

- every gate writes to a durable log directory **outside every directory the toolchain owns**;
- every gate's exit code is recorded **per gate**, so a contaminated step cannot silently merge into a
  roll-up;
- the candidate's product tree is diffed against the pin **before each judgement**, and the pin records
  its own voiding;
- the re-pins are explicit commits, so a reader can see exactly which tree each batch of evidence
  describes.

That is enough to proceed, and it is not enough to skip the caveat. **This should be raised with the
user before the final release verdict is issued**, because a second agent writing the same release
record is a coordination question, not a technical one.
