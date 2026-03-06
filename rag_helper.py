"""
StudyAI — RAG Helper
Semantic search powered by Mistral's codestral-embed model.
Falls back to BM25 if MISTRAL_API_KEY is absent.

Embedding model : codestral-embed  (1024-dim, 16k context)
Similarity      : cosine (dot-product on L2-normalised vectors)
Chunking        : 512-char chunks, 80-char overlap, boundary-aware
Batching        : up to 64 texts per API call
"""

import os
import re
import math
import time
from collections import Counter
from typing import List, Optional

import numpy as np
import requests


# ── Embedding API ──────────────────────────────────────────────────────────────

_EMBED_URL   = "https://api.mistral.ai/v1/embeddings"
_EMBED_MODEL = "codestral-embed"
_BATCH_SIZE  = 64        # well within Mistral API limits
_DIM         = 1024      # codestral-embed output dimension
_RETRY_MAX   = 3
_RETRY_DELAY = 1.5       # seconds, doubled on each retry


def _get_api_key() -> str:
    return os.environ.get("MISTRAL_API_KEY", "").strip()


def _embed_batch(texts: List[str], api_key: str) -> Optional[np.ndarray]:
    """
    Embed one batch of texts via codestral-embed.
    Returns (N, 1024) float32 array, each row L2-normalised.
    Returns None on unrecoverable failure.
    """
    for attempt in range(_RETRY_MAX):
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
                wait = _RETRY_DELAY * (2 ** attempt)
                print(f"[Embed] Rate-limited — retrying in {wait:.1f}s", flush=True)
                time.sleep(wait)
                continue
            r.raise_for_status()
            data = sorted(r.json()["data"], key=lambda x: x["index"])
            vecs = np.array([d["embedding"] for d in data], dtype=np.float32)
            norms = np.linalg.norm(vecs, axis=1, keepdims=True)
            norms = np.where(norms == 0, 1.0, norms)
            return vecs / norms
        except requests.RequestException as e:
            if attempt < _RETRY_MAX - 1:
                time.sleep(_RETRY_DELAY)
            else:
                print(f"[Embed] API error after {_RETRY_MAX} attempts: {e}", flush=True)
                return None
    return None


def _embed_many(texts: List[str], api_key: str) -> Optional[np.ndarray]:
    """Embed any number of texts, batching automatically."""
    if not texts:
        return np.zeros((0, _DIM), dtype=np.float32)
    parts = []
    for i in range(0, len(texts), _BATCH_SIZE):
        vecs = _embed_batch(texts[i : i + _BATCH_SIZE], api_key)
        if vecs is None:
            return None
        parts.append(vecs)
    return np.concatenate(parts, axis=0)


def _embed_one(text: str, api_key: str) -> Optional[np.ndarray]:
    """Embed a single string → (1024,) float32, L2-normalised."""
    vecs = _embed_batch([text], api_key)
    return vecs[0] if vecs is not None else None


# ── BM25 fallback ─────────────────────────────────────────────────────────────

def _bm25(query: str, chunks: List[str], k1: float = 1.5, b: float = 0.75) -> List[float]:
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
    N       = len(chunks)
    avg_len = total_len / N if N else 1
    scores  = []
    for tf in tokenized:
        dl = sum(tf.values())
        s  = 0.0
        for term in q_terms:
            if term not in tf:
                continue
            idf    = math.log((N - df[term] + 0.5) / (df[term] + 0.5) + 1)
            tf_n   = (tf[term] * (k1 + 1)) / (tf[term] + k1 * (1 - b + b * dl / avg_len))
            s     += idf * tf_n
        scores.append(s)
    return scores


# ── RAGHelper ─────────────────────────────────────────────────────────────────

class RAGHelper:
    # Smaller chunks → more semantically precise matches for codestral-embed
    CHUNK_SIZE    = 512
    CHUNK_OVERLAP = 80

    def __init__(self, collection_name: str = "study_materials",
                 persist_directory: Optional[str] = None):
        self.collection_name = collection_name
        self.chunks     : List[str]             = []
        self.embeddings : Optional[np.ndarray]  = None   # (N, 1024)
        self._semantic  : bool                  = bool(_get_api_key())
        if self._semantic:
            print("[RAGHelper] Mode: semantic (codestral-embed)", flush=True)
        else:
            print("[RAGHelper] Mode: BM25 (no MISTRAL_API_KEY)", flush=True)

    # ── Chunker ───────────────────────────────────────────────────────────

    def _split(self, text: str) -> List[str]:
        """Boundary-aware chunker — breaks at paragraph > sentence > line."""
        chunks: List[str] = []
        text  = text.strip()
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

    # ── Index builder ─────────────────────────────────────────────────────

    def _build_index(self) -> None:
        """Call Mistral to embed all chunks. Stores (N,1024) float32 array."""
        if not self.chunks:
            self.embeddings = None
            return
        api_key = _get_api_key()
        if not api_key:
            self.embeddings = None
            return
        n = len(self.chunks)
        print(f"[RAGHelper] Building semantic index: {n} chunks…", flush=True)
        t0   = time.time()
        vecs = _embed_many(self.chunks, api_key)
        if vecs is None:
            print("[RAGHelper] Embedding failed — BM25 fallback active", flush=True)
            self.embeddings = None
        else:
            self.embeddings = vecs
            print(f"[RAGHelper] Index ready: {n} chunks × {_DIM}d "
                  f"in {time.time()-t0:.1f}s", flush=True)

    def _ingest(self, chunks: List[str]) -> None:
        """Store chunks and build semantic index."""
        self.chunks     = chunks
        self.embeddings = None
        if self._semantic:
            self._build_index()

    # ── Loaders ───────────────────────────────────────────────────────────

    def load_pdf_ocr(self, pages: list) -> bool:
        chunks: List[str] = []
        for page in pages:
            text = (page.get("markdown") or "").strip()
            if not text:
                continue
            pnum = page.get("index", 0) + 1
            full = f"[Page {pnum}]\n{text}"
            chunks.extend(self._split(full) if len(full) > self.CHUNK_SIZE else [full])
        print(f"[RAGHelper] OCR: {len(pages)} pages → {len(chunks)} chunks", flush=True)
        self._ingest(chunks)
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
            print(f"[RAGHelper] pypdf: {len(reader.pages)} pages → {len(chunks)} chunks", flush=True)
            self._ingest(chunks)
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
            self._ingest(chunks)
            return len(self.chunks) > 0
        except Exception as e:
            print(f"[RAGHelper] Text load error: {e}", flush=True)
            return False

    def load_raw(self, text: str) -> None:
        chunks = self._split(text)
        print(f"[RAGHelper] Raw text: {len(chunks)} chunks", flush=True)
        self._ingest(chunks)

    def load_text_content(self, text: str, metadata: dict = None) -> bool:
        """Alias used by YouTube route."""
        self.load_raw(text)
        return len(self.chunks) > 0

    # ── Retrieval ─────────────────────────────────────────────────────────

    def query(self, question: str, k: int = 8) -> List[str]:
        if not self.chunks:
            return []

        # ── Semantic retrieval ─────────────────────────────────────────────
        if self.embeddings is not None and len(self.embeddings) == len(self.chunks):
            api_key = _get_api_key()
            if api_key:
                q_vec = _embed_one(question, api_key)
                if q_vec is not None:
                    # Dot product = cosine sim (vectors are L2-normalised)
                    sims   = self.embeddings @ q_vec          # (N,)
                    top_k  = min(k, len(sims))
                    ranked = np.argsort(sims)[::-1][:top_k]
                    return [self.chunks[i] for i in ranked]

        # ── BM25 fallback ──────────────────────────────────────────────────
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
        self.chunks     = []
        self.embeddings = None

    def clear_database(self) -> bool:
        self.clear()
        return True