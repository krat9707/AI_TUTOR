"""
StudyAI — Startup
Runs before Flask starts:
  1. Sets HuggingFace cache to project-local folder (survives Replit restarts)
  2. Auto-installs packages that don't persist across restarts
  3. Pre-downloads the embedding model
"""

import os
import subprocess
import sys

# ── Always set cache dirs before any HF import ────────────────────────────
_CACHE = os.path.join(os.getcwd(), ".hf_cache")
os.environ["HF_HOME"] = _CACHE
os.environ["SENTENCE_TRANSFORMERS_HOME"] = _CACHE
os.environ["TRANSFORMERS_CACHE"] = _CACHE
os.environ["HF_DATASETS_CACHE"] = _CACHE


def ensure_packages() -> None:
    """
    Auto-install packages that may not survive Replit restarts.
    Checks via import first — only installs if actually missing.
    """
    # { import_name : pip_package_name }
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


def preload_model() -> None:
    """
    Pre-download all-MiniLM-L6-v2 to the project-local cache.
    Subsequent calls are instant (model already on disk).
    """
    model_name = os.getenv(
        "EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2"
    )
    print(f"🧠  Checking embedding model: {model_name}")
    print(f"📁  Cache dir: {_CACHE}")

    try:
        from sentence_transformers import SentenceTransformer
        model = SentenceTransformer(model_name, cache_folder=_CACHE)
        _ = model.encode(["warm-up"], show_progress_bar=False)
        print("✅  Embedding model ready.\n")

    except ImportError:
        print("⚠️   sentence-transformers not installed — RAG will be unavailable.\n")
        print("     Run: pip install sentence-transformers\n")

    except Exception as e:
        print(f"⚠️   Model preload failed ({e}) — RAG may not work.\n")


if __name__ == "__main__":
    ensure_packages()
    preload_model()