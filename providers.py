"""
StudyAI — Provider & Model Registry
"""

import os, logging
from functools import lru_cache

import httpx

log = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────
# 1.  PROVIDERS
# ─────────────────────────────────────────────────────────────────────
PROVIDERS = {
    "groq": {
        "env_key":     "GROQ_API_KEY",
        "base_url":    "https://api.groq.com/openai/v1",
        "badge":       "Groq",
        "badge_color": "#1a6eff",
    },
    "openrouter": {
        "env_key":     "OPENROUTER_API_KEY",
        "base_url":    "https://openrouter.ai/api/v1",
        "badge":       "OpenRouter",
        "badge_color": "#8b5cf6",
    },
    "mistral": {
        "env_key":        "MISTRAL_API_KEY",
        "base_url":       "https://api.mistral.ai/v1",
        "badge":          "Mistral",
        "badge_color":    "#ff7000",
        "auto_discover":  True,
        "filter": lambda mid: not any(
            k in mid for k in ("embed", "moderation", "realtime")
        ),
    },
    "openai": {
        "env_key":     "OPENAI_API_KEY",
        "base_url":    "https://api.openai.com/v1",
        "badge":       "OpenAI",
        "badge_color": "#10b981",
    },
}

# ─────────────────────────────────────────────────────────────────────
# 2.  PINNED models (always listed first)
#     doc_capable=True  →  included in get_doc_models()
# ─────────────────────────────────────────────────────────────────────
PINNED = [
    {
        "id":          "groq_llama",
        "label":       "Llama 3.3 70B",
        "provider":    "groq",
        "model":       "llama-3.3-70b-versatile",
        "description": "Fast · Groq",
        "badge":       "Fast",
        "badge_color": "#1a6eff",
        "doc_capable": True,   # 128k context, excellent reading comprehension
    },
    {
        "id":          "openrouter_qwen",
        "label":       "Qwen 3 VL 30B",
        "provider":    "openrouter",
        "model":       "qwen/qwen3-vl-30b-a3b-thinking",
        "description": "Thinking · OpenRouter",
        "badge":       "Smart",
        "badge_color": "#8b5cf6",
        "doc_capable": True,   # VL = vision+language, great for docs
    },
]

DEFAULT_MODEL_ID = "groq_llama"

# backwards compat
MODELS = PINNED

# ─────────────────────────────────────────────────────────────────────
# 3.  Auto-discovery
# ─────────────────────────────────────────────────────────────────────
@lru_cache(maxsize=16)
def _fetch_remote(provider: str) -> tuple:
    cfg     = PROVIDERS.get(provider, {})
    api_key = os.environ.get(cfg.get("env_key", ""), "").strip()
    if not api_key:
        return ()
    try:
        r = httpx.get(
            f"{cfg['base_url']}/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=10,
        )
        r.raise_for_status()
        ids  = sorted(m["id"] for m in r.json().get("data", []))
        filt = cfg.get("filter")
        if filt:
            ids = [i for i in ids if filt(i)]
        return tuple(ids)
    except Exception as exc:
        log.warning("model discovery for %s failed: %s", provider, exc)
        return ()


def _auto_entry(provider: str, model_id: str) -> dict:
    cfg   = PROVIDERS[provider]
    safe  = (f"{provider}_{model_id}"
             .replace("/", "_").replace("-", "_").replace(".", "_"))
    label = model_id.replace("-", " ").replace("_", " ").title()
    return {
        "id":          safe,
        "label":       label,
        "provider":    provider,
        "model":       model_id,
        "env_key":     cfg["env_key"],
        "description": cfg["badge"],
        "badge":       cfg["badge"],
        "badge_color": cfg["badge_color"],
        # All auto-discovered models are assumed doc-capable
        # (they're cloud APIs with large context windows)
        "doc_capable": True,
    }


def _all_models() -> list:
    seen: set = set()
    out:  list = []

    for m in PINNED:
        m.setdefault("env_key", PROVIDERS[m["provider"]]["env_key"])
        seen.add(m["id"])
        out.append(m)

    for name, cfg in PROVIDERS.items():
        if not cfg.get("auto_discover"):
            continue
        for mid in _fetch_remote(name):
            entry = _auto_entry(name, mid)
            if entry["id"] not in seen:
                seen.add(entry["id"])
                out.append(entry)

    return out


# ─────────────────────────────────────────────────────────────────────
# 4.  Public API
# ─────────────────────────────────────────────────────────────────────
def get_model(model_id: str) -> dict | None:
    return next((m for m in _all_models() if m["id"] == model_id), None)


def get_default() -> dict:
    return get_model(DEFAULT_MODEL_ID) or PINNED[0]


def available_models() -> list:
    return [
        {**m, "available": bool(os.environ.get(m["env_key"], "").strip())}
        for m in _all_models()
    ]


def get_doc_models() -> list:
    """
    Models suitable for document RAG — large context windows, strong reading
    comprehension. Returned only if the provider API key is present.

    Includes:
    - Pinned models with doc_capable=True
    - All auto-discovered Mistral / OpenAI models (both have 32k+ context)
    """
    result = []
    for m in available_models():
        if not m.get("available"):
            continue
        if m.get("doc_capable"):
            result.append(m)
        elif m["provider"] in ("mistral", "openai") and not m.get("doc_capable") is False:
            # auto-discovered cloud models → include
            result.append(m)
    return result


def get_api_key(provider: str) -> str:
    cfg = PROVIDERS.get(provider, {})
    return os.environ.get(cfg.get("env_key", ""), "")


def refresh_discovered():
    _fetch_remote.cache_clear()