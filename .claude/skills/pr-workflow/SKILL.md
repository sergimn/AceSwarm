---
name: pr-workflow
description: How a change reaches main in AceSwarm. Use whenever you commit, push, open, update, review or merge a pull request in this repository.
---

# Pull request workflow

Every change reaches `main` through a pull request. Never push to `main`.

## 1. Branch and commit

- Work on a branch. If your session was given one, use it and push to no other.
- Run `npm run check` (typecheck, lint, format check, unit tests) before you push.
- Write the commit subject as a plain sentence that says what changes, such as "Lower the default engine memory cache to 128 MB". The body says why.

## 2. Keep it safe to publish

This repository is public. In commits, PR text, code, comments and docs:

- Never mention a personal machine used for testing, or anything about one: host name, operating system, user names, paths, device or environment ids, network details. Call it "Testing environment" and leave it at that.
- Keep credentials, real VPN profiles and internal notes out.

## 3. Open the pull request

- Open it as soon as the branch is pushed, ready for review, not as a draft.
- Title: the same style as a commit subject. Pull requests are squash merged, so the title becomes the commit on `main`.
- Body: start with the attribution lines your session gives you, exactly as given. Then say why, what changed and how you tested it (`## Why`, `## What changed`, `## Tests`).
- Assign `sergimn` and request their review. If that fails, carry on.

## 4. Checks

Two workflows run on every pull request:

- **CI**: lint, typecheck, unit tests, pre-commit hooks and the image builds for amd64 and arm64.
- **E2E**: the stack with real Acestream engines, on Docker and on rootless Podman.

Both must be green before a merge.

- When E2E fails, re-run all its jobs, never only the failed one: the runners only work together.
- Never skip, disable or loosen a test to get green. Find the cause, or say that you couldn't.

## 5. Review

- Start a fresh, independent agent to review every pull request. Give it the pull request, not your reasoning, so that it judges the diff on its own.
- Address its findings, push, and have a fresh agent review again. Every follow-up commit needs a new review, however small.
- Repeat until the reviewer approves.

## 6. Bring the branch up to date

Merge `main` into the branch with a merge commit. Don't rebase a pushed branch, because the force push that it needs is denied.

## 7. Merge

- Merge only when the reviewer has approved the latest commit and the checks are green. Use a squash merge.
- If the merge is refused because no person has reviewed the pull request, say so in the thread and wait. The maintainer answers "merge if confident" when you may go ahead, and that answer covers only that pull request.
