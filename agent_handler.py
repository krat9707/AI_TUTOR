"""
StudyAI — Agent Handler
Bridges the Flask routes with the AI agents and RAG pipeline.
All heavy lifting is done here; routes just call these methods.
"""

import os
import yaml
from typing import Optional


class StudyAssistantHandler:
    def __init__(
        self,
        topic: str,
        subject_category: str,
        knowledge_level: str,
        learning_goal: str,
        time_available: str,
        learning_style: str,
        model_name: str = "llama-3.3-70b-versatile",
        provider: str = "groq",
    ):
        self.topic = topic
        self.subject_category = subject_category
        self.knowledge_level = knowledge_level
        self.learning_goal = learning_goal
        self.time_available = time_available
        self.learning_style = learning_style
        self.model_name = model_name
        self.provider = provider
        self.rag_helper: Optional[object] = None

        # Import here so env vars are already set before model init
        from study_agents import StudyAgents
        self.agents = StudyAgents(
            topic, subject_category, knowledge_level, learning_goal,
            time_available, learning_style, model_name, provider,
        )
        self.config = self._load_config()

    # ── Helpers ────────────────────────────────────────────────────────────

    def _load_config(self) -> dict:
        base = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(base, "prompts.yaml")
        with open(path, "r") as f:
            return yaml.safe_load(f)

    def _fmt(self, tpl: str, **kw) -> str:
        """Safe format — ignore missing keys rather than raising KeyError."""
        try:
            return tpl.format(**kw)
        except KeyError as e:
            print(f"[Handler] Missing prompt key: {e}")
            return tpl

    def _run_agent(self, agent, prompt: str) -> str:
        """Run an agent and extract its text content safely."""
        try:
            resp = agent.run(prompt, stream=False)
            # agno: resp.content is a list of message objects OR a plain string
            if hasattr(resp, "content"):
                c = resp.content
                if isinstance(c, str):
                    return c
                if isinstance(c, list):
                    # Extract text from agno message content blocks
                    parts = []
                    for block in c:
                        if isinstance(block, str):
                            parts.append(block)
                        elif hasattr(block, "text"):
                            parts.append(block.text)
                        elif hasattr(block, "content"):
                            parts.append(str(block.content))
                    return "\n".join(parts)
                return str(c)
            # phidata plain string response
            return str(resp)
        except Exception as e:
            raise RuntimeError(f"Agent run failed: {e}") from e

    # ── Core AI methods ────────────────────────────────────────────────────

    def analyze_student(self) -> str:
        """Run the student analyser agent and return the analysis text."""
        agent = self.agents.student_analyzer_agent()
        prompt = self._fmt(
            self.config["prompts"]["student_analysis"]["base"],
            topic=self.topic,
            subject_category=self.subject_category,
            knowledge_level=self.knowledge_level,
            learning_goal=self.learning_goal,
            time_available=self.time_available,
            learning_style=self.learning_style,
        )
        return self._run_agent(agent, prompt)

    def create_roadmap(self, student_analysis: str) -> str:
        """Create a phased learning roadmap based on the student analysis."""
        agent = self.agents.roadmap_creator_agent()
        prompt = self._fmt(
            self.config["prompts"]["roadmap_creation"]["base"],
            student_analysis=student_analysis,
            topic=self.topic,
            learning_goal=self.learning_goal,
            time_available=self.time_available,
            knowledge_level=self.knowledge_level,
        )
        return self._run_agent(agent, prompt)

    def find_resources(self) -> str:
        """Find and curate learning resources using web search."""
        agent = self.agents.resource_finder_agent()
        prompt = self._fmt(
            self.config["prompts"]["resource_finding"]["base"],
            topic=self.topic,
            learning_goal=self.learning_goal,
            knowledge_level=self.knowledge_level,
            learning_style=self.learning_style,
        )
        return self._run_agent(agent, prompt)

    def generate_quiz(
        self,
        difficulty_level: str = "intermediate",
        focus_areas: str = "general",
        num_questions: int = 10,
    ) -> str:
        """Generate an adaptive quiz at the requested difficulty."""
        agent = self.agents.quiz_generator_agent()
        prompt = self._fmt(
            self.config["prompts"]["quiz_generation"]["base"],
            topic=self.topic,
            difficulty_level=difficulty_level,
            focus_areas=focus_areas,
            num_questions=num_questions,
        )
        return self._run_agent(agent, prompt)

    def get_tutoring(self, student_question: str, context: str = "") -> str:
        """Answer a student question with the tutor agent."""
        agent = self.agents.tutor_agent()
        prompt = self._fmt(
            self.config["prompts"]["tutoring"]["base"],
            student_question=student_question,
            context=context,
            knowledge_level=self.knowledge_level,
        )
        return self._run_agent(agent, prompt)

    # ── RAG methods ────────────────────────────────────────────────────────

    def initialize_rag(self, collection_name: str = "study_materials"):
        """Lazily initialise the RAG helper / vector store."""
        from rag_helper import RAGHelper
        self.rag_helper = RAGHelper(collection_name=collection_name)

    def add_document_to_rag(self, file_path: str, file_type: str = "pdf") -> bool:
        """Embed a document file into the vector store."""
        if not self.rag_helper:
            self.initialize_rag()
        if file_type == "pdf":
            return self.rag_helper.load_pdf(file_path)
        elif file_type == "text":
            return self.rag_helper.load_text(file_path)
        return False

    def query_documents(self, question: str, k: int = 4) -> str:
        """Query the RAG knowledge base and return a grounded answer."""
        if not self.rag_helper:
            return (
                "No documents have been uploaded yet. "
                "Please upload study materials first."
            )

        docs = self.rag_helper.query(question, k=k)
        if not docs:
            return (
                "I couldn't find relevant information in your uploaded documents. "
                "Try rephrasing your question or uploading more materials."
            )

        context = "\n\n---\n\n".join(docs)
        agent = self.agents.rag_tutor_agent()
        prompt = self._fmt(
            self.config["prompts"]["rag_query"]["base"],
            question=question,
            context=context,
        )
        return self._run_agent(agent, prompt)

    def get_document_count(self) -> int:
        """Return the number of chunks currently in the vector store."""
        if not self.rag_helper:
            return 0
        return self.rag_helper.get_document_count()

    def clear_documents(self) -> bool:
        """Wipe the entire RAG knowledge base."""
        if not self.rag_helper:
            return False
        return self.rag_helper.clear_database()