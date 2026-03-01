"""
StudyAI — Startup / Model Preloader
Runs before Flask starts. Downloads and caches the HuggingFace
embedding model to .hf_cache/ inside the project directory so it
survives Replit restarts without re-downloading every time.
"""

import os

# ── Always set cache dirs before any HF import ────────────────────────────
_CACHE = os.path.join(os.getcwd(), ".hf_cache")
os.environ["HF_HOME"] = _CACHE
os.environ["SENTENCE_TRANSFORMERS_HOME"] = _CACHE
os.environ["TRANSFORMERS_CACHE"] = _CACHE        
os.environ["HF_DATASETS_CACHE"] = _CACHE


def preload_model():
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
        # Quick smoke test
        _ = model.encode(["warm-up"], show_progress_bar=False)
        print("✅  Embedding model ready.\n")

    except ImportError:
        print("⚠️   sentence-transformers not installed — RAG will be unavailable.")
        print("     Run: pip install sentence-transformers\n")

    except Exception as e:
        print(f"⚠️   Model preload failed ({e}) — RAG may not work.\n")


if __name__ == "__main__":
    preload_model()