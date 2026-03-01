#!/usr/bin/env python3
"""
StudyAI — Launcher
Automatically kills anything on the target port before starting Flask.
"""

import os
import signal
import subprocess
import threading
import time
import webbrowser

# ── Point HuggingFace cache to persistent project subfolder ───────────────
_CACHE = os.path.join(os.getcwd(), ".hf_cache")
os.environ["HF_HOME"] = _CACHE
os.environ["SENTENCE_TRANSFORMERS_HOME"] = _CACHE
os.environ["TRANSFORMERS_CACHE"] = _CACHE


def kill_port(port: int):
    """Kill any process currently listening on the given port."""
    print(f"🔍  Checking port {port}...")
    killed = False

    # Method 1: fuser
    try:
        result = subprocess.run(
            ["fuser", "-k", f"{port}/tcp"],
            capture_output=True, timeout=5
        )
        if result.returncode == 0:
            print(f"✅  Cleared port {port} via fuser.")
            killed = True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # Method 2: ss + kill
    if not killed:
        try:
            result = subprocess.run(
                ["ss", "-tlnp", f"sport = :{port}"],
                capture_output=True, text=True, timeout=5
            )
            for line in result.stdout.splitlines():
                if f":{port}" in line and "pid=" in line:
                    pid = line.split("pid=")[1].split(",")[0]
                    os.kill(int(pid), signal.SIGKILL)
                    print(f"✅  Killed PID {pid} on port {port}.")
                    killed = True
        except Exception:
            pass

    # Method 3: /proc scan (always works on Linux)
    if not killed:
        try:
            for pid_str in os.listdir("/proc"):
                if not pid_str.isdigit():
                    continue
                try:
                    fd_dir = f"/proc/{pid_str}/fd"
                    for fd in os.listdir(fd_dir):
                        try:
                            link = os.readlink(f"{fd_dir}/{fd}")
                            if f":{port}" in link:
                                os.kill(int(pid_str), signal.SIGKILL)
                                print(f"✅  Killed PID {pid_str} on port {port} via /proc.")
                                killed = True
                                break
                        except (OSError, ValueError):
                            continue
                except (PermissionError, FileNotFoundError, ProcessLookupError):
                    continue
        except Exception:
            pass

    if not killed:
        print(f"ℹ️   Port {port} was already free.")

    time.sleep(1)  # Let OS release the port


def preload_embedding_model():
    from startup import preload_model
    preload_model()


def _open_browser(port: int):
    time.sleep(2)
    webbrowser.open(f"http://localhost:{port}")


if __name__ == "__main__":
    PORT  = int(os.getenv("PORT", 5000))
    DEBUG = os.getenv("FLASK_DEBUG", "false").lower() == "true"

    kill_port(PORT)
    preload_embedding_model()

    from app import app

    print(f"""
╔══════════════════════════════════════════════════════╗
║   🎓  StudyAI — Multi-Agent Learning Platform         ║
╠══════════════════════════════════════════════════════╣
║   🌐  http://localhost:{PORT:<28}  ║
║   🔧  Debug mode : {str(DEBUG):<32}  ║
║   🗄️  Database   : studyai.db (SQLite)               ║
║   🧠  RAG store  : ./chroma_db  (local, CPU)         ║
╚══════════════════════════════════════════════════════╝
""")

    if not DEBUG:
        threading.Thread(target=_open_browser, args=(PORT,), daemon=True).start()

    app.run(host="0.0.0.0", port=PORT, debug=DEBUG,
            use_reloader=False, threaded=True)