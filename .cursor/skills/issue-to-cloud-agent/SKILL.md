---
name: issue-to-cloud-agent
description: Launches a Cursor Cloud Agent from a newly opened GitHub issue using a labeled GitHub Actions workflow. Use when setting up or modifying issue-triggered automation, prompt passthrough from issue body, branch naming for agent runs, or status comments back on the issue.
---

# Issue To Cloud Agent

## Purpose

Use this skill to implement or update a GitHub Actions workflow that:
- listens for new issues
- filters by a trigger label (for example `cursor-trigger`)
- launches a Cursor Cloud Agent with the issue body as prompt text
- comments agent metadata (ID and URL) back on the issue

## Standard Workflow Pattern

1. Trigger on `issues` with `types: [opened]`.
2. Gate execution with a label check.
3. Read `CURSOR_API_KEY` from repo secrets.
4. Build Basic auth: `base64("${CURSOR_API_KEY}:")`.
5. Call `POST https://api.cursor.com/v0/agents`.
6. Use `prompt.text` from the issue body.
7. Set `source.repository` to `context.payload.repository.html_url`.
8. Set `source.ref` to default branch.
9. Optionally set `target.branchName` to create a feature branch.
10. Comment `Agent ID` and `Agent URL` on the issue.

## Minimal Prompt Contract

- Primary instruction comes from issue body.
- If teams use `@cursor ...` convention, pass it through exactly as entered.
- Include full external references (for example a full Miro board URL) in the issue body, not a derived ID.

## Required Secrets And Permissions

- Secret: `CURSOR_API_KEY`
- GitHub workflow permissions: `issues: write` to comment status

## Failure Handling

- If `CURSOR_API_KEY` is missing, fail fast with a clear error.
- If launch API returns non-2xx, include status and response body in thrown error.
- Keep issue comments short and deterministic.

## Defaults For This Repo

- Workflow file: `.github/workflows/issue-opened.yml`
- Trigger label: `cursor-trigger`
- Model: `"default"`
- Branch naming format (if enabled): `cursor/issue-<number>-<slug>`
