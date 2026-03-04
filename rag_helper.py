"""
StudyAI — RAG Helper
"""

import os
from typing import List, Optional, Tuple
from langchain_community.document_loaders import PyPDFLoader, TextLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_chroma import Chroma
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_core.documents import Document
import chromadb

_CACHE = os.path.join(os.getcwd(), ".hf_cache")
os.environ.setdefault("HF_HOME", _CACHE)
os.environ.setdefault("SENTENCE_TRANSFORMERS_HOME", _CACHE)
os.environ.setdefault("TRANSFORMERS_CACHE", _CACHE)


class RAGHelper:
    def __init__(
        self,
        collection_name: str = "study_materials",
        persist_directory: str = "./chroma_db",
    ):
        self.collection_name = collection_name
        self.persist_directory = persist_directory

        self.embeddings = HuggingFaceEmbeddings(
            model_name="sentence-transformers/all-MiniLM-L6-v2",
            model_kwargs={"device": "cpu"},
            encode_kwargs={"normalize_embeddings": True},
            cache_folder=_CACHE,
        )

        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=1500,
            chunk_overlap=300,
            length_function=len,
            separators=["\n\n", "\n", ". ", " ", ""],
        )

        self.vectorstore: Optional[Chroma] = None
        self._initialize_vectorstore()

    def _initialize_vectorstore(self) -> None:
        try:
            os.makedirs(self.persist_directory, exist_ok=True)
            self.vectorstore = Chroma(
                collection_name=self.collection_name,
                embedding_function=self.embeddings,
                persist_directory=self.persist_directory,
            )
        except Exception as e:
            print(f"[RAGHelper] Vector store init error: {e}")
            self.vectorstore = None

    def load_pdf(self, file_path: str) -> bool:
        try:
            loader = PyPDFLoader(file_path)
            documents = loader.load()
            raw_text = " ".join(d.page_content for d in documents)
            return self.load_text_content(raw_text, metadata={"source": file_path, "type": "pdf"})
        except Exception as e:
            print(f"[RAGHelper] PDF load error: {e}")
            return False

    def load_text(self, file_path: str) -> bool:
        try:
            loader = TextLoader(file_path, encoding="utf-8")
            documents = loader.load()
            raw_text = " ".join(d.page_content for d in documents)
            return self.load_text_content(raw_text, metadata={"source": file_path, "type": "text"})
        except Exception as e:
            print(f"[RAGHelper] Text load error: {e}")
            return False

    def load_text_content(self, text: str, metadata: Optional[dict] = None) -> bool:
        try:
            # Split raw text into chunks without going through Document loader
            # to avoid langchain.schema import issues across versions
            chunks_text = self.text_splitter.split_text(text)
            if not chunks_text:
                return False

            meta = metadata or {}

            # Try langchain vectorstore path first
            if self.vectorstore:
                try:
                    from langchain_core.documents import Document as LCDoc
                    docs = [LCDoc(page_content=c, metadata=meta) for c in chunks_text]
                    self.vectorstore.add_documents(docs)
                    print(f"[RAGHelper] Indexed {len(docs)} chunks via langchain.")
                    return True
                except Exception as lc_err:
                    print(f"[RAGHelper] langchain path failed ({lc_err}), trying direct chromadb...")

            # Direct chromadb fallback — no langchain.schema dependency at all
            try:
                import chromadb, hashlib, json
                client = chromadb.PersistentClient(path=self.persist_directory)
                col = client.get_or_create_collection(
                    name=self.collection_name,
                    metadata={"hnsw:space": "cosine"}
                )
                embeddings = self.embeddings.embed_documents(chunks_text)
                ids = [
                    hashlib.md5(f"{meta.get('source','')}{i}{c[:40]}".encode()).hexdigest()
                    for i, c in enumerate(chunks_text)
                ]
                col.add(
                    documents=chunks_text,
                    embeddings=embeddings,
                    metadatas=[meta] * len(chunks_text),
                    ids=ids
                )
                print(f"[RAGHelper] Indexed {len(chunks_text)} chunks via direct chromadb.")
                return True
            except Exception as db_err:
                print(f"[RAGHelper] Direct chromadb also failed: {db_err}")
                return False

        except Exception as e:
            print(f"[RAGHelper] Text content load error: {e}")
            return False

    def query(self, question: str, k: int = 8) -> List[str]:
        try:
            if not self.vectorstore:
                return []
            docs = self.vectorstore.similarity_search(question, k=k)
            return [doc.page_content for doc in docs]
        except Exception as e:
            print(f"[RAGHelper] Query error: {e}")
            return []

    def query_with_scores(self, question: str, k: int = 8) -> List[Tuple[str, float]]:
        try:
            if not self.vectorstore:
                return []
            results = self.vectorstore.similarity_search_with_score(question, k=k)
            return [(doc.page_content, float(score)) for doc, score in results]
        except Exception as e:
            print(f"[RAGHelper] Scored query error: {e}")
            return []

    def clear_database(self) -> bool:
        try:
            client = chromadb.PersistentClient(path=self.persist_directory)
            client.delete_collection(name=self.collection_name)
            self._initialize_vectorstore()
            return True
        except Exception as e:
            print(f"[RAGHelper] Clear error: {e}")
            return False

    def get_document_count(self) -> int:
        try:
            if self.vectorstore:
                return self.vectorstore._collection.count()
            return 0
        except Exception as e:
            print(f"[RAGHelper] Count error: {e}")
            return 0