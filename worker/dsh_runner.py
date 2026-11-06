#!/usr/bin/env python3
"""One-turn DeepSeek Harness SDK runner bound to the disposable workspace."""
import argparse
import os
from pathlib import Path

from deepseek_harness import DeepSeekHarness

parser = argparse.ArgumentParser()
parser.add_argument("--workspace", type=Path, required=True)
parser.add_argument("--dsh-home", type=Path, required=True)
parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-flash"))
parser.add_argument("prompt")
args = parser.parse_args()

with DeepSeekHarness(
    provider="deepseek-official",
    model=args.model,
    cwd=str(args.workspace.resolve()),
    dsh_home=str(args.dsh_home.resolve()),
    profile="sdk-minimal",
) as harness:
    result = harness.run(args.prompt)
    if result.finish_reason not in (None, "completed"):
        raise RuntimeError(f"Harness turn ended with {result.finish_reason}: {result.final_response}")
    print(result.final_response)
