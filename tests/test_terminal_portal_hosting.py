#!/usr/bin/env python3
"""Regression: terminal views should be portal-hosted near the window root.

This catches regressions where terminal NSViews are reattached deep inside the SwiftUI
hierarchy, which increases Core Animation commit traversal depth and input latency.
"""

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from remux import remux, remuxError


SOCKET_PATH = os.environ.get("REMUX_SOCKET", "/tmp/remux-debug.sock")


def main() -> int:
    with remux(SOCKET_PATH) as c:
        c.activate_app()

        c.new_workspace()
        time.sleep(0.2)
        c.new_split("right")
        time.sleep(0.8)

        health = c.surface_health()
        terminals = [row for row in health if row.get("type") == "terminal"]
        if len(terminals) < 2:
            raise remuxError(f"expected >=2 terminal surfaces after split, got={terminals}")

        for row in terminals:
            if not row.get("in_window", False):
                raise remuxError(f"terminal not attached to window: {row}")
            if row.get("portal") is not True:
                raise remuxError(f"terminal is not portal-hosted: {row}")
            depth = row.get("view_depth")
            if not isinstance(depth, int):
                raise remuxError(f"missing view_depth in surface_health: {row}")
            if depth > 8:
                raise remuxError(f"terminal view depth too deep ({depth}): {row}")

        print("PASS: terminal surfaces are portal-hosted with shallow view depth")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
