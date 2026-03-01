"""
StudyAI — RAG Helper
Handles document loading, chunking, embedding, and vector search.
Uses HuggingFace sentence-transformers (fully local, no API key needed).
Cache is stored in .hf_cache/ inside the project so it survives Replit restarts.
"""

import os
from typing import List, Optional
from langchain_community.document_loaders import PyPDFLoader, TextLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_chroma import Chroma
from langchain_huggingface import HuggingFaceEmbeddings
import chromadb

_CACHE = os.path.join(os.getcwd(), ".hf_cache")
os.environ.setdefault("HF_HOME", _CACHE)
os.environ.setdefault("SENTENCE_TRANSFORMERS_HOME", _CACHE)
os.environ.setdefault("TRANSFORMERS_CACHE", _CACHE)


class RAGHelper:
    """
    Helper class for RAG (Retrieval Augmented Generation) functionality.
    Uses HuggingFace sentence-transformers for embeddings — fully free, no API key required.
    """

    def __init__(
        self,
        collection_name: str = "study_materials",
        persist_directory: str = "./chroma_db",
    ):
        self.collection_name = collection_name
        self.persist_directory = persist_directory

        # Free local embeddings — no API key needed, runs on CPU
        self.embeddings = HuggingFaceEmbeddings(
            model_name="sentence-transformers/all-MiniLM-L6-v2",
            model_kwargs={"device": "cpu"},
            encode_kwargs={"normalize_embeddings": True},
        )

        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=1000,
            chunk_overlap=200,
            length_function=len,
        )
        self.vectorstore = None
        self._initialize_vectorstore()

    def _initialize_vectorstore(self):
        """Initialize or load the ChromaDB vector store."""
        try:
            os.makedirs(self.persist_directory, exist_ok=True)
            self.vectorstore = Chroma(
                collection_name=self.collection_name,
                embedding_function=self.embeddings,
                persist_directory=self.persist_directory,
            )
        except Exception as e:
            print(f"Error initializing vector store: {e}")
            self.vectorstore = None

    def load_pdf(self, file_path: str) -> bool:
        """Load a PDF file and add it to the knowledge base."""
        try:
            loader = PyPDFLoader(file_path)
            documents = loader.load()
            chunks = self.text_splitter.split_documents(documents)
            if self.vectorstore:
                self.vectorstore.add_documents(chunks)
                return True
            return False
        except Exception as e:
            print(f"Error loading PDF: {e}")
            return False

    def load_text(self, file_path: str) -> bool:
        """Load a text file and add it to the knowledge base."""
        try:
            loader = TextLoader(file_path)
            documents = loader.load()
            chunks = self.text_splitter.split_documents(documents)
            if self.vectorstore:
                self.vectorstore.add_documents(chunks)
                return True
            return False
        except Exception as e:
            print(f"Error loading text file: {e}")
            return False

    def load_text_content(self, text: str, metadata: dict = None) -> bool:
        """Load raw text content directly into the knowledge base."""
        try:
            from langchain.schema import Document

            doc = Document(page_content=text, metadata=metadata or {})
            chunks = self.text_splitter.split_documents([doc])
            if self.vectorstore:
                self.vectorstore.add_documents(chunks)
                return True
            return False
        except Exception as e:
            print(f"Error loading text content: {e}")
            return False

    def query(self, question: str, k: int = 4) -> List[str]:
        """Query the knowledge base and return relevant document contents."""
        try:
            if not self.vectorstore:
                return []
            docs = self.vectorstore.similarity_search(question, k=k)
            return [doc.page_content for doc in docs]
        except Exception as e:
            print(f"Error querying knowledge base: {e}")
            return []

    def query_with_scores(self, question: str, k: int = 4) -> List[tuple]:
        """Query the knowledge base and return (content, score) tuples."""
        try:
            if not self.vectorstore:
                return []
            results = self.vectorstore.similarity_search_with_score(question, k=k)
            return [(doc.page_content, score) for doc, score in results]
        except Exception as e:
            print(f"Error querying knowledge base: {e}")
            return []

    def clear_database(self) -> bool:
        """Clear all documents from the database."""
        try:
            if self.vectorstore:
                client = chromadb.PersistentClient(path=self.persist_directory)
                client.delete_collection(name=self.collection_name)
                self._initialize_vectorstore()
                return True
            return False
        except Exception as e:
            print(f"Error clearing database: {e}")
            return False

    def get_document_count(self) -> int:
        """Return the number of document chunks currently stored."""
        try:
            if self.vectorstore:
                return self.vectorstore._collection.count()
            return 0
        except Exception as e:
            print(f"Error getting document count: {e}")
            return 0