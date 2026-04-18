#!/usr/bin/env bash
set -euo pipefail

python3 - <<'PY'
import json
import os
import subprocess
import sys

WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "StrReplace", "Delete", "ApplyPatch", "EditNotebook"}
PATH_KEYS = {"path", "file", "filename", "target_file", "target_notebook"}


def allow():
    print('{"permission":"allow"}')
    sys.exit(0)


def deny(paths):
    preview = ", ".join(sorted(set(paths))[:5])
    print(json.dumps({
        "permission": "deny",
        "user_message": f"On cursor/issue-* branches, test-agent edits are restricted to test/. Blocked path(s): {preview}",
        "agent_message": "This Cursor issue branch is restricted for test-agent edits. Modify files only in test/."
    }))
    sys.exit(0)


def walk_paths(node):
    if isinstance(node, dict):
        for key, value in node.items():
            if key in PATH_KEYS and isinstance(value, str):
                yield value
            yield from walk_paths(value)
    elif isinstance(node, list):
        for item in node:
            yield from walk_paths(item)


payload = json.loads(sys.stdin.read() or "{}")
tool = next((str(payload.get(k, "")) for k in ("tool_name", "toolName", "name", "tool") if payload.get(k)), "")
if tool.split(".")[-1] not in WRITE_TOOLS:
    allow()

branch = subprocess.check_output(["git", "rev-parse", "--abbrev-ref", "HEAD"], text=True, stderr=subprocess.DEVNULL).strip()
if not branch.startswith("cursor/issue-"):
    allow()

root = os.getcwd()
bad = []
for raw in walk_paths(payload):
    rel = os.path.relpath(raw, root) if os.path.isabs(raw) else os.path.normpath(raw)
    rel = rel.replace("\\", "/")
    if rel != "test" and not rel.startswith("test/"):
        bad.append(rel)

if bad:
    deny(bad)
allow()
PY
