"""
StudyAI — Startup
Runs before Flask starts:
  1. Auto-installs packages that may not persist across Replit restarts
"""

import os
import subprocess
import sys


def ensure_packages() -> None:
    """
    Auto-install packages that may not survive Replit restarts.
    Checks via import first — only installs if actually missing.
    """
    packages = {
        "duckduckgo_search": "duckduckgo-search",
    }

    for import_name, pip_name in packages.items():
        try:
            __import__(import_name)
            print(f"✅  {pip_name} already installed.")
        except ImportError:
            print(f"📦  Installing {pip_name}...")
            result = subprocess.run(
                [sys.executable, "-m", "pip", "install", pip_name,
                 "--break-system-packages", "-q"],
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                print(f"✅  {pip_name} installed successfully.")
            else:
                print(f"⚠️   Failed to install {pip_name}: {result.stderr.strip()}")


if __name__ == "__main__":
    ensure_packages()