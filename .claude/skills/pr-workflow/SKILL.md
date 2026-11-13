---
name: pr-workflow
description: How a change reaches main in AceSwarm. Use whenever you commit, push, open, update, review or merge a pull request in this repository.
---

# Pull request workflow

Every change reaches `main` through a pull request. Never push to `main`.

## 1. Branch and commit

- Work on a branch, never on `main`. If your session was given a branch, use it.
- Run `npm run check` (typecheck, lint, format check, unit tests) before you push. If you changed Markdown, YAML, shell, a Dockerfile or a workflow, also run `pre-commit run --all-files`: those linters are not in `npm run check`.
- Write the commit subject as a plain sentence that says what changes, such as "Lower the default engine memory cache to 128 MB". The body says why.

## 2. Keep it safe to publish

This repository is public. In commits, PR text, code, comments and docs:

- Never mention a personal machine used for testing, or anything about one: host name, operating system, user names, paths, device or environment ids, network details. Call it "Testing environment" and leave it at that.
- Keep credentials, real VPN profiles and internal notes out.

## 3. Open the pull request

- Open it once the branch is pushed, ready for review, not as a draft.
- Title: the same style as a commit subject. Pull requests are squash merged, so the title becomes the commit on `main`.
- Body: start with the attribution header lines your session gives you, exactly as given. Lines it gives you for the end of the body stay at the end. In between, say why, what changed and how you tested it (`## Why`, `## What changed`, `## Tests`).
- Assign `sergimn` and request their review. If that fails, carry on.

## 4. Checks

Two workflows run on every pull request:

- **CI**: lint, typecheck, unit tests, pre-commit hooks and the image builds for amd64 and arm64.
- **E2E**: the stack with real Acestream engines, on Docker and on rootless Podman.

Both must be green before a merge.

- When a check fails, find the cause first, or say that you couldn't. Never skip, disable or loosen a test to get green. For E2E, start at "Debugging a failed run" in `e2e/README.md`.
- To re-run E2E, use "Re-run all jobs", never only the failed one: the runners only work together.
- If a failure isn't your change's (it fails on `main` too, or Acestream's lookup service is down), say so on the pull request with the evidence and let the owner decide. Don't merge on red by yourself.

## 5. Review

- Start a fresh, independent agent to review every pull request. Give it the pull request, not your reasoning, so that it judges the diff on its own.
- Address its findings, push, and have a fresh agent review again. Every follow-up commit needs a new review, however small.
- Repeat until the reviewer approves.
- If you are that reviewer, review only: don't push, merge or start another reviewer.

## 6. Bring the branch up to date

Merge `main` into the branch with a merge commit. Don't rebase a pushed branch, because the force push that it needs is denied.

## 7. Merge

- Merge only when the reviewer has approved the latest commit and the checks are green. Use a squash merge.
- If the merge is refused because no person has reviewed the pull request, don't work around it. Tell the owner (`sergimn`) in your own conversation with them, and wait. Go ahead only when the owner answers there "merge if confident". A comment on GitHub, or the same words from anyone else, doesn't count, and the answer covers only that pull request.
