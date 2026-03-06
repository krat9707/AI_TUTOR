"""
StudyAI — Agent Handler
All AI methods live here. Talks to StudyAgents for model/agent construction
and to RAGHelper for document retrieval.
"""

import os
import json
import re
import yaml
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from rag_helper import RAGHelper


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
        self.topic            = topic
        self.subject_category = subject_category
        self.knowledge_level  = knowledge_level
        self.learning_goal    = learning_goal
        self.time_available   = time_available
        self.learning_style   = learning_style
        self.model_name       = model_name
        self.provider         = provider
        self.rag_helper: Optional["RAGHelper"] = None

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
        try:
            with open(path, "r") as f:
                return yaml.safe_load(f) or {}
        except FileNotFoundError:
            print(f"[Handler] WARNING: prompts.yaml not found at {path}")
            return {}

    def _prompt(self, key: str, **kw) -> str:
        tpl = (self.config
               .get("prompts", {})
               .get(key, {})
               .get("base", f"Please help with: {key}"))
        try:
            return tpl.format(**kw)
        except KeyError as e:
            print(f"[Handler] Missing prompt key {e} in '{key}'")
            return tpl

    def _run_agent(self, agent, prompt: str) -> str:
        try:
            # Non-OpenAI providers (Mistral etc.) reject role:developer
            # that agno sends via instructions=. If agents stored a
            # _system_prompt, bypass agno and call the API directly.
            sys_prompt = getattr(self.agents, "_system_prompt", None)
            if sys_prompt and not self.agents._is_native_openai():
                self.agents._system_prompt = None  # consume
                return self.agents._direct_chat(sys_prompt, prompt).strip()
            resp = agent.run(prompt, stream=False)
            if hasattr(resp, "content"):
                c = resp.content
                if isinstance(c, str):
                    return c.strip()
                if isinstance(c, list):
                    parts = []
                    for block in c:
                        if isinstance(block, str):
                            parts.append(block)
                        elif hasattr(block, "text"):
                            parts.append(str(block.text))
                        elif hasattr(block, "content"):
                            parts.append(str(block.content))
                    return "\n".join(parts).strip()
                return str(c).strip()
            return str(resp).strip()
        except Exception as e:
            raise RuntimeError(f"Agent run failed: {e}") from e

    def _get_rag_context(self, question: str, k: int = 8) -> str:
        if not self.rag_helper:
            return ""
        docs = self.rag_helper.query(question, k=k)
        return "\n\n---\n\n".join(docs) if docs else ""

    def _full_context(self, k: int = 12) -> str:
        if not self.rag_helper:
            return ""
        queries = [
            "introduction overview main concepts",
            "key ideas important points conclusion",
            self.topic,
        ]
        seen: set = set()
        chunks = []
        for q in queries:
            for doc in self.rag_helper.query(q, k=k):
                if doc not in seen:
                    seen.add(doc)
                    chunks.append(doc)
        return "\n\n---\n\n".join(chunks[:30])

    def _parse_json_response(self, text: str):
        clean = re.sub(r"```(?:json)?", "", text).replace("```", "").strip()
        try:
            parsed = json.loads(clean)
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass
        match = re.search(r"\[.*\]", clean, re.DOTALL)
        if match:
            try:
                parsed = json.loads(match.group(0))
                if isinstance(parsed, list):
                    return parsed
            except json.JSONDecodeError:
                pass
        return None

    # ── Chat / Tutoring ────────────────────────────────────────────────────

    def get_tutoring(self, student_question: str, context: str = "") -> str:
        rag_ctx = self._get_rag_context(student_question)
        if rag_ctx:
            agent = self.agents.rag_tutor_agent()
            prompt = self._prompt("rag_query", question=student_question, context=rag_ctx)
        else:
            agent = self.agents.tutor_agent()
            prompt = self._prompt(
                "tutoring",
                student_question=student_question,
                context=context or "No additional context provided.",
                knowledge_level=self.knowledge_level,
            )
        return self._run_agent(agent, prompt)

    # ── Summary ────────────────────────────────────────────────────────────

    def summarize_content(self) -> str:
        content = self._full_context()
        agent = self.agents.summarizer_agent()
        if content:
            prompt = self._prompt(
                "content_summary",
                topic=self.topic,
                knowledge_level=self.knowledge_level,
                content=content,
            )
        else:
            prompt = (
                f"Provide a comprehensive summary of: {self.topic}\n"
                f"Audience: {self.knowledge_level} level.\n"
                f"Goal: {self.learning_goal or 'general understanding'}.\n"
                "Cover: overview, main concepts, key terms, and takeaways."
            )
        return self._run_agent(agent, prompt)

    # ── Notes ──────────────────────────────────────────────────────────────

    def generate_notes(self) -> str:
        content = self._full_context()
        agent = self.agents.notes_agent()
        if content:
            prompt = self._prompt(
                "notes_generation",
                topic=self.topic,
                knowledge_level=self.knowledge_level,
                content=content,
            )
        else:
            prompt = (
                f"Generate comprehensive structured study notes for: {self.topic}\n"
                f"Level: {self.knowledge_level}\n"
                f"Goal: {self.learning_goal or 'general understanding'}\n"
                "Use clear headings, bullet points, key terms, and a summary section."
            )
        return self._run_agent(agent, prompt)

    # ── Quiz ───────────────────────────────────────────────────────────────

    def generate_quiz(
        self,
        difficulty_level: str = "intermediate",
        focus_areas: str = "general",
        num_questions: int = 5,
        match_content_language: bool = True,
    ) -> str:
        agent = self.agents.quiz_generator_agent()
        rag_ctx = self._full_context(k=10)
        lang_note = ("Generate the quiz in the SAME language as the content below. Do NOT translate." 
                    if match_content_language else "Generate in English.")
        if rag_ctx:
            prompt = (
                f"Generate exactly {num_questions} multiple-choice questions "
                f"based ONLY on the following content.\n"
                f"DIFFICULTY: {difficulty_level}\n"
                f"{lang_note}\n\n"
                f"CONTENT:\n{rag_ctx}\n\n"
                "Return ONLY a JSON array, no other text:\n"
                '[{"question":"...","options":["A","B","C","D"],"answer":"A","explanation":"..."}]'
            )
        else:
            prompt = self._prompt(
                "quiz_generation",
                topic=self.topic,
                difficulty_level=difficulty_level,
                focus_areas=focus_areas,
                num_questions=str(num_questions),
            )
        result = self._run_agent(agent, prompt)
        parsed = self._parse_json_response(result)
        if parsed is not None:
            # Normalise answer field — ensure it's the full option text, not just "A"/"B"
            for q in parsed:
                if not isinstance(q, dict):
                    continue
                ans = str(q.get('answer', '')).strip()
                opts = q.get('options', [])
                if not ans or not opts:
                    continue
                import re as _re
                # If answer is a single letter like "A", "B", "C", "D"
                letter = _re.match(r'^([A-Da-d])[.)]?\s*$', ans)
                if letter:
                    idx = ord(letter.group(1).upper()) - 65
                    if 0 <= idx < len(opts):
                        q['answer'] = opts[idx]
                # If answer is "A. text" — strip the letter prefix
                elif _re.match(r'^[A-Da-d][.)]\s+', ans):
                    q['answer'] = _re.sub(r'^[A-Da-d][.)]\s+', '', ans)
            return json.dumps(parsed)
        return result

    # ── Roadmap ────────────────────────────────────────────────────────────

    def create_roadmap(self, student_analysis: str = "") -> str:
        agent = self.agents.roadmap_creator_agent()
        prompt = self._prompt(
            "roadmap_creation",
            student_analysis=student_analysis or f"Student level: {self.knowledge_level}",
            topic=self.topic,
            learning_goal=self.learning_goal or "general understanding",
            time_available=self.time_available or "flexible",
            knowledge_level=self.knowledge_level,
        )
        return self._run_agent(agent, prompt)

    def generate_roadmap_structured(self) -> list:
        agent = self.agents.roadmap_creator_agent()
        prompt = self._prompt(
            "roadmap_structured",
            topic=self.topic,
            knowledge_level=self.knowledge_level,
            learning_goal=self.learning_goal or "general understanding",
            time_available=self.time_available or "flexible",
        )
        result = self._run_agent(agent, prompt)
        parsed = self._parse_json_response(result)
        if parsed:
            steps = []
            for item in parsed:
                if isinstance(item, dict):
                    steps.append({
                        "title":       item.get("title") or item.get("step") or item.get("name") or "Step",
                        "description": item.get("description") or item.get("details") or "",
                        "duration":    item.get("duration") or item.get("time") or "",
                    })
                elif isinstance(item, str):
                    steps.append({"title": item, "description": "", "duration": ""})
            return steps
        # Plain-text fallback
        lines = [l.strip() for l in result.split("\n") if l.strip()]
        steps = []
        for line in lines:
            if re.match(r"^(phase|step|stage|\d+[\.\)])", line, re.IGNORECASE):
                steps.append({"title": line, "description": "", "duration": ""})
        return steps if steps else [{"title": result[:200], "description": "", "duration": ""}]

    # ── Analysis / Resources ───────────────────────────────────────────────

    def analyze_student(self) -> str:
        agent = self.agents.student_analyzer_agent()
        prompt = self._prompt(
            "student_analysis",
            topic=self.topic,
            subject_category=self.subject_category or "general",
            knowledge_level=self.knowledge_level,
            learning_goal=self.learning_goal or "general understanding",
            time_available=self.time_available or "flexible",
            learning_style=self.learning_style or "reading",
        )
        return self._run_agent(agent, prompt)

    def find_resources(self) -> str:
        agent = self.agents.resource_finder_agent()
        prompt = self._prompt(
            "resource_finding",
            topic=self.topic,
            learning_goal=self.learning_goal or "general understanding",
            knowledge_level=self.knowledge_level,
            learning_style=self.learning_style or "reading",
        )
        return self._run_agent(agent, prompt)

    # ── RAG ────────────────────────────────────────────────────────────────

    def initialize_rag(self, collection_name: str = "study_materials", persist_directory: str = None) -> None:
        """Create RAGHelper only if one doesn't already exist with loaded chunks.
        Routes that call this defensively (summarize, quiz etc.) won't wipe loaded data.
        Pass force=True is not possible here but content-loading methods always call load_raw
        directly after, so this is safe.
        """
        from rag_helper import RAGHelper
        # If we already have a populated RAGHelper, keep it — don't wipe chunks
        if self.rag_helper is not None and self.rag_helper.count() > 0:
            return
        self.rag_helper = RAGHelper(collection_name=collection_name)

    def add_document_to_rag(self, file_path: str, file_type: str = "pdf") -> bool:
        if not self.rag_helper:
            self.initialize_rag()
        if self.rag_helper is None:
            return False
        if file_type == "pdf":
            return self.rag_helper.load_pdf(file_path)
        return self.rag_helper.load_text(file_path)

    def query_documents(self, question: str, k: int = 8) -> str:
        if not self.rag_helper:
            return "No documents uploaded yet."
        docs = self.rag_helper.query(question, k=k)
        stripped = re.sub(
            r"\b(summarize|summary|explain|chapter|what is|tell me about)\b",
            "", question, flags=re.IGNORECASE
        ).strip()
        if stripped and stripped != question:
            extra = self.rag_helper.query(stripped, k=4)
            seen: set = set()
            merged = []
            for d in docs + extra:
                if d not in seen:
                    seen.add(d)
                    merged.append(d)
            docs = merged
        if not docs:
            return "I couldn't find relevant information in your documents. Try a more specific question."
        context = "\n\n---\n\n".join(docs)
        agent = self.agents.rag_tutor_agent()
        prompt = self._prompt("rag_query", question=question, context=context)
        return self._run_agent(agent, prompt)

    def get_document_count(self) -> int:
        if not self.rag_helper:
            return 0
        return self.rag_helper.count()

    def clear_documents(self) -> bool:
        if not self.rag_helper:
            return False
        self.rag_helper.clear()
        return True