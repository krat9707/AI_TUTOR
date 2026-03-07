"""
StudyAI — RAG Helper
Semantic search via Mistral codestral-embed with:
  - Parallel batch embedding  (ThreadPoolExecutor, ~15x faster than serial)
  - Disk cache               (uploads/{sid}.npz — instant on restart)
  - BM25 fallback            (if MISTRAL_API_KEY absent or API fails)

Cache strategy
  - Named  uploads/{sid}.npz  (one file per session, bounded storage)
  - Stores  chunks + embeddings + sha256(raw_text[:64])
  - Invalidated automatically when new content is ingested (file deleted
    before embed, rewritten after)
  - Deleted on session clear/delete via RAGHelper.clear()
"""

import os
import re
import math
import time
import hashlib
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Optional, Tuple

import numpy as np
import requests


# ── Constants ─────────────────────────────────────────────────────────────────

_EMBED_URL   = "https://api.mistral.ai/v1/embeddings"
_EMBED_MODEL = "codestral-embed"
_BATCH_SIZE  = 128     # 128 chunks × 512 chars — safe per-request size
_MAX_WORKERS = 3       # conservative: 3 concurrent requests avoids 429 bursts
_DIM         = 1024    # codestral-embed output dimension
_RETRY_MAX   = 8       # more retries — 429 is transient, never give up to BM25
_RETRY_BASE  = 2.0     # base wait in seconds


# ── Shared rate-limit gate ────────────────────────────────────────────────────
# When any worker hits a 429, it sets _rl_until to (now + backoff).
# All workers check this before firing and sleep until it clears.
# This prevents the thundering-herd where all workers resume simultaneously.

_rl_lock  = threading.Lock()
_rl_until = 0.0   # epoch seconds; 0 means no active backoff


def _rl_wait() -> None:
    """Block until the shared rate-limit cooldown has elapsed."""
    with _rl_lock:
        remaining = _rl_until - time.time()
    if remaining > 0:
        time.sleep(remaining)


def _rl_set(seconds: float) -> None:
    """Set a shared cooldown. Only extends, never shortens."""
    global _rl_until
    with _rl_lock:
        _rl_until = max(_rl_until, time.time() + seconds)


# ── API helpers ───────────────────────────────────────────────────────────────

def _get_api_key() -> str:
    return os.environ.get("MISTRAL_API_KEY", "").strip()


def _embed_batch(texts: List[str], api_key: str, batch_idx: int = 0
                 ) -> Tuple[int, Optional[np.ndarray]]:
    """
    Embed one batch with shared rate-limit awareness.
    - Before each attempt: honours the global cooldown (_rl_wait)
    - On 429: sets global cooldown so ALL workers pause together
    - Retries up to _RETRY_MAX times before giving up
    Returns (batch_idx, array) on success, (batch_idx, None) on hard failure.
    """
    for attempt in range(_RETRY_MAX):
        _rl_wait()  # respect shared cooldown before firing
        try:
            r = requests.post(
                _EMBED_URL,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type":  "application/json",
                },
                json={"model": _EMBED_MODEL, "input": texts},
                timeout=60,
            )
            if r.status_code == 429:
                # Parse Retry-After header if present, else exponential backoff
                retry_after = r.headers.get("Retry-After")
                wait = float(retry_after) if retry_after else _RETRY_BASE * (2 ** attempt)
                print(f"[Embed] 429 — global cooldown {wait:.1f}s "
                      f"(batch {batch_idx}, attempt {attempt+1})", flush=True)
                _rl_set(wait)   # tell ALL workers to pause
                _rl_wait()      # this worker waits too
                continue
            r.raise_for_status()
            data = sorted(r.json()["data"], key=lambda x: x["index"])
            vecs = np.array([d["embedding"] for d in data], dtype=np.float32)
            norms = np.linalg.norm(vecs, axis=1, keepdims=True)
            norms = np.where(norms == 0, 1.0, norms)
            return batch_idx, vecs / norms
        except requests.RequestException as exc:
            wait = _RETRY_BASE * (2 ** attempt)
            if attempt < _RETRY_MAX - 1:
                print(f"[Embed] batch {batch_idx} network error "
                      f"(attempt {attempt+1}): {exc} — retry in {wait:.1f}s",
                      flush=True)
                time.sleep(wait)
            else:
                print(f"[Embed] batch {batch_idx} failed after "
                      f"{_RETRY_MAX} attempts: {exc}", flush=True)
                return batch_idx, None
    return batch_idx, None


def _embed_parallel(texts: List[str], api_key: str) -> Optional[np.ndarray]:
    """
    Embed all texts using _MAX_WORKERS parallel workers with shared
    rate-limit coordination. Never falls back to BM25 due to 429s alone
    — retries until _RETRY_MAX is exhausted.
    Returns (N, 1024) float32 array, or None only on hard API failure.
    """
    if not texts:
        return np.zeros((0, _DIM), dtype=np.float32)

    batches = [
        (i // _BATCH_SIZE, texts[i : i + _BATCH_SIZE])
        for i in range(0, len(texts), _BATCH_SIZE)
    ]
    n_batches = len(batches)
    workers   = min(_MAX_WORKERS, n_batches)
    results: dict = {}

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_embed_batch, batch, api_key, idx): idx
            for idx, batch in batches
        }
        for future in as_completed(futures):
            idx, vecs = future.result()
            if vecs is None:
                for f in futures:
                    f.cancel()
                return None
            results[idx] = vecs

    return np.concatenate([results[i] for i in range(n_batches)], axis=0)


def _embed_one(text: str, api_key: str) -> Optional[np.ndarray]:
    """Embed a single query string → (1024,) L2-normalised float32."""
    _, vecs = _embed_batch([text], api_key, batch_idx=0)
    return vecs[0] if vecs is not None else None


# ── Cache helpers ─────────────────────────────────────────────────────────────

def _text_hash(text: str) -> str:
    """Short SHA-256 fingerprint of the raw text."""
    return hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()[:16]


def _cache_path(cache_dir: str, sid: str) -> str:
    return os.path.join(cache_dir, f"{sid}.npz")


def _save_cache(path: str, chunks: List[str],
                embeddings: np.ndarray, text_hash: str) -> None:
    """Save chunks + embeddings + hash to a .npz file."""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # numpy can't store a list of strings directly as a structured array;
        # store as object array
        chunks_arr = np.empty(len(chunks), dtype=object)
        for i, c in enumerate(chunks):
            chunks_arr[i] = c
        np.savez_compressed(
            path,
            embeddings=embeddings,
            chunks=chunks_arr,
            text_hash=np.array([text_hash]),
        )
        mb = os.path.getsize(path) / 1024 / 1024
        print(f"[Cache] Saved {path} ({mb:.1f} MB)", flush=True)
    except Exception as e:
        print(f"[Cache] Save failed: {e}", flush=True)


def _load_cache(path: str, expected_hash: str
                ) -> Tuple[Optional[List[str]], Optional[np.ndarray]]:
    """
    Load cache if it exists and hash matches.
    Returns (chunks, embeddings) or (None, None) on miss/mismatch.
    """
    if not os.path.exists(path):
        return None, None
    try:
        data        = np.load(path, allow_pickle=True)
        stored_hash = str(data["text_hash"][0])
        if stored_hash != expected_hash:
            print(f"[Cache] Hash mismatch — stale cache, re-embedding", flush=True)
            os.remove(path)
            return None, None
        chunks     = list(data["chunks"])
        embeddings = data["embeddings"].astype(np.float32)
        mb = os.path.getsize(path) / 1024 / 1024
        print(f"[Cache] Hit {path} — {len(chunks)} chunks ({mb:.1f} MB)", flush=True)
        return chunks, embeddings
    except Exception as e:
        print(f"[Cache] Load failed: {e} — re-embedding", flush=True)
        try:
            os.remove(path)
        except Exception:
            pass
        return None, None


def _delete_cache(path: str) -> None:
    try:
        if os.path.exists(path):
            os.remove(path)
            print(f"[Cache] Deleted {path}", flush=True)
    except Exception as e:
        print(f"[Cache] Delete failed: {e}", flush=True)


# ── BM25 fallback ─────────────────────────────────────────────────────────────

def _bm25(query: str, chunks: List[str],
          k1: float = 1.5, b: float = 0.75) -> List[float]:
    q_terms = re.findall(r"\w+", query.lower())
    if not q_terms:
        return [0.0] * len(chunks)
    tokenized: List[Counter] = []
    df: Counter = Counter()
    total_len = 0
    for chunk in chunks:
        words = re.findall(r"\w+", chunk.lower())
        tf = Counter(words)
        tokenized.append(tf)
        total_len += len(words)
        for term in set(q_terms) & set(words):
            df[term] += 1
    N = len(chunks)
    avg_len = total_len / N if N else 1
    scores = []
    for tf in tokenized:
        dl = sum(tf.values())
        s = 0.0
        for term in q_terms:
            if term not in tf:
                continue
            idf  = math.log((N - df[term] + 0.5) / (df[term] + 0.5) + 1)
            tf_n = (tf[term] * (k1 + 1)) / (tf[term] + k1 * (1 - b + b * dl / avg_len))
            s   += idf * tf_n
        scores.append(s)
    return scores


# ── RAGHelper ─────────────────────────────────────────────────────────────────

class RAGHelper:
    CHUNK_SIZE    = 512
    CHUNK_OVERLAP = 80

    def __init__(self, collection_name: str = "study_materials",
                 persist_directory: Optional[str] = None,
                 sid: Optional[str] = None,
                 cache_dir: Optional[str] = None):
        self.collection_name = collection_name
        self.sid             = sid        # session id — used as cache filename
        self.cache_dir       = cache_dir  # directory to store .npz files
        self.chunks     : List[str]            = []
        self.embeddings : Optional[np.ndarray] = None   # (N, 1024)
        self._semantic  : bool                 = bool(_get_api_key())
        if self._semantic:
            print("[RAGHelper] Mode: semantic (codestral-embed + parallel + cache)",
                  flush=True)
        else:
            print("[RAGHelper] Mode: BM25 (no MISTRAL_API_KEY)", flush=True)

    # ── Chunker ───────────────────────────────────────────────────────────

    def _split(self, text: str) -> List[str]:
        """Boundary-aware chunker — paragraph > sentence > line."""
        chunks: List[str] = []
        text = text.strip()
        start = 0
        while start < len(text):
            end = min(start + self.CHUNK_SIZE, len(text))
            if end < len(text):
                for sep in ["\n\n", ".\n", ". ", "!\n", "? ", "\n"]:
                    idx = text.rfind(sep, start + self.CHUNK_SIZE // 2, end)
                    if idx != -1:
                        end = idx + len(sep)
                        break
            chunk = text[start:end].strip()
            if chunk:
                chunks.append(chunk)
            next_start = end - self.CHUNK_OVERLAP
            if next_start <= start:
                next_start = start + 1
            start = next_start
        return chunks

    # ── Cache path ────────────────────────────────────────────────────────

    def _cache_file(self) -> Optional[str]:
        if self.sid and self.cache_dir:
            return _cache_path(self.cache_dir, self.sid)
        return None

    # ── Index builder ─────────────────────────────────────────────────────

    def _build_index(self, raw_text_for_hash: str = "") -> None:
        """
        Build semantic index with parallel embedding + disk cache.
        1. Check cache (keyed by sid + hash of raw text)
        2. Cache hit  → load embeddings from disk, done in ~1s
        3. Cache miss → embed in parallel, save to disk
        """
        if not self.chunks:
            self.embeddings = None
            return

        api_key = _get_api_key()
        if not api_key:
            self.embeddings = None
            return

        text_hash  = _text_hash(raw_text_for_hash) if raw_text_for_hash else ""
        cache_file = self._cache_file()

        # ── Try cache first ────────────────────────────────────────────────
        if cache_file and text_hash:
            cached_chunks, cached_emb = _load_cache(cache_file, text_hash)
            if cached_chunks is not None and cached_emb is not None:
                # Validate shape matches current chunks
                if len(cached_chunks) == len(self.chunks) and \
                   cached_emb.shape == (len(self.chunks), _DIM):
                    self.embeddings = cached_emb
                    return
                else:
                    print("[Cache] Shape mismatch — re-embedding", flush=True)

        # ── Cache miss: embed in parallel ──────────────────────────────────
        n = len(self.chunks)
        n_batches = math.ceil(n / _BATCH_SIZE)
        workers   = min(_MAX_WORKERS, n_batches)
        print(f"[RAGHelper] Embedding {n} chunks "
              f"({n_batches} batches × {_BATCH_SIZE}, {workers} workers)…",
              flush=True)
        t0   = time.time()
        vecs = _embed_parallel(self.chunks, api_key)

        if vecs is None:
            print("[RAGHelper] Embedding failed — BM25 fallback active", flush=True)
            self.embeddings = None
            return

        self.embeddings = vecs
        elapsed = time.time() - t0
        print(f"[RAGHelper] Index ready: {n} chunks × {_DIM}d "
              f"in {elapsed:.1f}s  "
              f"({n/elapsed:.0f} chunks/s)", flush=True)

        # ── Save to cache ──────────────────────────────────────────────────
        if cache_file and text_hash:
            _save_cache(cache_file, self.chunks, vecs, text_hash)

    def _ingest(self, chunks: List[str], raw_text: str = "") -> None:
        """
        Store chunks, delete stale cache, build fresh index.
        raw_text is used for cache key hashing.
        """
        # Delete any existing cache for this session — content is changing
        cache_file = self._cache_file()
        if cache_file:
            _delete_cache(cache_file)

        self.chunks     = chunks
        self.embeddings = None

        if self._semantic:
            self._build_index(raw_text_for_hash=raw_text)

    # ── Loaders ───────────────────────────────────────────────────────────

    def load_pdf_ocr(self, pages: list, raw_text: str = "") -> bool:
        chunks: List[str] = []
        for page in pages:
            text = (page.get("markdown") or "").strip()
            if not text:
                continue
            pnum = page.get("index", 0) + 1
            full = f"[Page {pnum}]\n{text}"
            chunks.extend(self._split(full) if len(full) > self.CHUNK_SIZE else [full])
        print(f"[RAGHelper] OCR: {len(pages)} pages → {len(chunks)} chunks", flush=True)
        self._ingest(chunks, raw_text=raw_text)
        return len(self.chunks) > 0

    def load_pdf(self, file_path: str) -> bool:
        try:
            from pypdf import PdfReader
            reader = PdfReader(file_path)
            pages  = [p.extract_text() or "" for p in reader.pages]
            text   = "\n\n".join(
                f"[Page {i+1}]\n{p.strip()}"
                for i, p in enumerate(pages) if p.strip()
            )
            chunks = self._split(text)
            print(f"[RAGHelper] pypdf: {len(reader.pages)} pages → "
                  f"{len(chunks)} chunks", flush=True)
            self._ingest(chunks, raw_text=text)
            return len(self.chunks) > 0
        except Exception as e:
            print(f"[RAGHelper] PDF load error: {e}", flush=True)
            return False

    def load_text(self, file_path: str) -> bool:
        try:
            with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read()
            chunks = self._split(text)
            print(f"[RAGHelper] Text file: {len(chunks)} chunks", flush=True)
            self._ingest(chunks, raw_text=text)
            return len(self.chunks) > 0
        except Exception as e:
            print(f"[RAGHelper] Text load error: {e}", flush=True)
            return False

    def load_raw(self, text: str) -> None:
        chunks = self._split(text)
        print(f"[RAGHelper] Raw text: {len(chunks)} chunks", flush=True)
        self._ingest(chunks, raw_text=text)

    def load_text_content(self, text: str, metadata: dict = None) -> bool:
        """Alias used by YouTube route."""
        self.load_raw(text)
        return len(self.chunks) > 0

    # ── Rebuild from cache (server restart) ───────────────────────────────

    def load_from_cache_or_raw(self, text: str) -> bool:
        """
        Called by _rebuild_handler on server restart.
        Tries cache first (instant). Falls back to re-embedding from text.
        Returns True if semantic index is ready (or BM25 is active).
        """
        chunks = self._split(text)
        if not chunks:
            return False

        api_key    = _get_api_key()
        text_hash  = _text_hash(text)
        cache_file = self._cache_file()

        # ── Try cache ─────────────────────────────────────────────────────
        if api_key and cache_file and text_hash:
            cached_chunks, cached_emb = _load_cache(cache_file, text_hash)
            if cached_chunks is not None and cached_emb is not None and \
               len(cached_chunks) == len(chunks) and \
               cached_emb.shape == (len(chunks), _DIM):
                self.chunks     = cached_chunks
                self.embeddings = cached_emb
                print(f"[RAGHelper] Restored from cache: "
                      f"{len(self.chunks)} chunks", flush=True)
                return True

        # ── Cache miss — re-embed (happens only on first run or after cache cleared) ──
        self._ingest(chunks, raw_text=text)
        return len(self.chunks) > 0

    # ── Retrieval ─────────────────────────────────────────────────────────

    def query(self, question: str, k: int = 8) -> List[str]:
        if not self.chunks:
            return []

        # ── Semantic ──────────────────────────────────────────────────────
        if self.embeddings is not None and \
           len(self.embeddings) == len(self.chunks):
            api_key = _get_api_key()
            if api_key:
                q_vec = _embed_one(question, api_key)
                if q_vec is not None:
                    sims   = self.embeddings @ q_vec      # cosine sim (L2-normed)
                    top_k  = min(k, len(sims))
                    ranked = np.argsort(sims)[::-1][:top_k]
                    return [self.chunks[i] for i in ranked]

        # ── BM25 fallback ─────────────────────────────────────────────────
        scores = _bm25(question, self.chunks)
        ranked = sorted(range(len(scores)), key=lambda i: -scores[i])
        top    = [self.chunks[i] for i in ranked[:k] if scores[i] > 0]
        return top if top else self.chunks[:k]

    # ── Compatibility aliases ──────────────────────────────────────────────

    def count(self) -> int:
        return len(self.chunks)

    def get_document_count(self) -> int:
        return len(self.chunks)

    def clear(self) -> None:
        cache_file = self._cache_file()
        if cache_file:
            _delete_cache(cache_file)
        self.chunks     = []
        self.embeddings = None

    def clear_database(self) -> bool:
        self.clear()
        return True