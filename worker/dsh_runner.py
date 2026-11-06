#!/usr/bin/env python3
"""One-turn DeepSeek Harness SDK runner bound to the disposable workspace."""
import argparse
import json
import os
import sys
from pathlib import Path

from deepseek_harness import DeepSeekHarness

parser = argparse.ArgumentParser()
parser.add_argument("--workspace", type=Path, required=True)
parser.add_argument("--dsh-home", type=Path, required=True)
parser.add_argument("--session-id", default=os.environ.get("DSH_SESSION_ID", ""))
parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-flash"))
parser.add_argument("prompt")
args = parser.parse_args()

with DeepSeekHarness(
    provider="deepseek-official",
    model=args.model,
    cwd=str(args.workspace.resolve()),
    dsh_home=str(args.dsh_home.resolve()),
    dsh_bin=os.environ.get("DSH_BIN", "/opt/dsh-cli/node_modules/.bin/dsh"),
    profile="sdk-minimal",
) as harness:
    session_id = args.session_id or f"task-{os.getpid()}"
    resume_marker = args.dsh_home / ".superagent-sessions" / session_id
    session = harness.resume_session(session_id) if resume_marker.exists() else harness.start_session(session_id)
    result = session.run(args.prompt)
    if result.finish_reason not in (None, "completed"):
        diagnostics = [
            event for event in result.events
            if "error" in str(event.get("type", "")).lower() or event.get("type") == "turn/end"
        ]
        if diagnostics:
            print("DSH_DIAGNOSTICS " + json.dumps(diagnostics, ensure_ascii=False)[:4000], file=sys.stderr)
        raise RuntimeError(f"Harness turn ended with {result.finish_reason}: {result.final_response}")
    print(result.final_response)
    resume_marker.parent.mkdir(parents=True, exist_ok=True)
    resume_marker.touch(mode=0o600, exist_ok=True)
