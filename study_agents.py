"""
StudyAI — Study Agents
"""

import os
import yaml
from typing import Any, List


def _detect_framework() -> str:
    try:
        import agno  # noqa: F401
        return "agno"
    except ImportError:
        pass
    try:
        import phi  # noqa: F401
        return "phi"
    except ImportError:
        pass
    raise ImportError(
        "\n\n❌  No AI agent framework found!\n"
        "    Run: pip install agno\n"
    )


FRAMEWORK = _detect_framework()
print(f"✅  Agent framework: {FRAMEWORK}")


class StudyAgents:
    def __init__(
        self,
        topic: str,
        subject_category: str,
        knowledge_level: str,
        learning_goal: str,
        time_available: str,
        learning_style: str,
        model_name: str = "qwen3-vl-30b-a3b-thinking",
        provider: str = "openrouter",
    ) -> None:
        self.topic = topic
        self.subject_category = subject_category
        self.knowledge_level = knowledge_level
        self.learning_goal = learning_goal
        self.time_available = time_available
        self.learning_style = learning_style
        self.model_name = model_name
        self.provider = provider
        self._cfg = self._load_config()

    def _load_config(self) -> dict:
        base = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(base, "prompts.yaml")
        with open(path, "r") as f:
            return yaml.safe_load(f)

    def _persona(self, key: str) -> str:
        return str(self._cfg.get("personas", {}).get(key, {}).get("system_prompt", ""))

    def _style_info(self) -> dict:
        return dict(self._cfg.get("learning_styles", {}).get(self.learning_style, {}))

    def _get_model(self, temperature: float = 0.7) -> Any:
        openrouter_key = os.getenv("OPENROUTER_API_KEY")
        groq_key = os.getenv("GROQ_API_KEY")

        print(openrouter_key)
        print(groq_key)

        if FRAMEWORK == "agno":
            if groq_key:
                from agno.models.groq import Groq
                return Groq(id=self.model_name, temperature=temperature)
            elif openrouter_key:
                from agno.models.openai import OpenAIChat
                return OpenAIChat(
                    id=self.model_name,
                    temperature=temperature,
                    api_key=openrouter_key,
                    base_url="https://openrouter.ai/api/v1",
                )
            else:
                raise ValueError("No API key found. Set OPENROUTER_API_KEY or GROQ_API_KEY")

        else:
            if groq_key:
                from phi.model.groq import Groq
                return Groq(id=self.model_name, temperature=temperature)
            elif openrouter_key:
                from phi.model.openai import OpenAIChat
                return OpenAIChat(
                    id=self.model_name,
                    temperature=temperature,
                    api_key=openrouter_key,
                    base_url="https://openrouter.ai/api/v1",
                )
            else:
                raise ValueError("No API key found.")
                
    def _get_search_tools(self) -> List[Any]:
        try:
            if FRAMEWORK == "agno":
                from agno.tools.duckduckgo import DuckDuckGoTools  # type: ignore[import]
                return [DuckDuckGoTools()]
            from phi.tools.duckduckgo import DuckDuckGo  # type: ignore[import]
            return [DuckDuckGo()]
        except ImportError:
            print("⚠️  DuckDuckGo not available — resource search uses model knowledge only.")
            return []

    def _make_agent(
        self,
        system_prompt: str,
        temperature: float = 0.7,
        use_search: bool = False,
    ) -> Any:
        model = self._get_model(temperature)
        tools = self._get_search_tools() if use_search else []

        if FRAMEWORK == "agno":
            from agno.agent import Agent  # type: ignore[import]
            kwargs: dict = dict(model=model, instructions=system_prompt, markdown=True)
            if tools:
                kwargs["tools"] = tools
            return Agent(**kwargs)
        else:
            from phi.agent import Agent  # type: ignore[import]
            kwargs = dict(model=model, system_prompt=system_prompt)
            if tools:
                kwargs["tools"] = tools
                kwargs["show_tool_calls"] = False
            return Agent(**kwargs)

    # ── Agents ─────────────────────────────────────────────────────────────

    def student_analyzer_agent(self) -> Any:
        style = self._style_info()
        prompt = f"""{self._persona('student_analyzer')}

You are analysing a student who wants to learn: {self.topic}

STUDENT PROFILE:
- Current Knowledge Level : {self.knowledge_level}
- Learning Goal           : {self.learning_goal}
- Available Time          : {self.time_available}
- Learning Style          : {self.learning_style}
- Style Notes             : {style.get('description', '')}
"""
        return self._make_agent(prompt, temperature=0.6)

    def roadmap_creator_agent(self) -> Any:
        style = self._style_info()
        recs: List[str] = list(style.get("recommendations", []))
        prompt = f"""{self._persona('roadmap_creator')}

You are creating a personalised learning roadmap for: {self.topic}

STUDENT CONTEXT:
- Knowledge Level : {self.knowledge_level}
- Learning Goal   : {self.learning_goal}
- Time Available  : {self.time_available}
- Learning Style  : {self.learning_style}

LEARNING STYLE RECOMMENDATIONS:
{chr(10).join(f'- {r}' for r in recs)}
"""
        return self._make_agent(prompt, temperature=0.7)

    def quiz_generator_agent(self) -> Any:
        prompt = f"""{self._persona('quiz_generator')}

You are creating quizzes for a student learning: {self.topic}

STUDENT LEVEL : {self.knowledge_level}
LEARNING GOAL : {self.learning_goal}
"""
        return self._make_agent(prompt, temperature=0.5)

    def tutor_agent(self) -> Any:
        style = self._style_info()
        prompt = f"""{self._persona('tutor_agent')}

You are tutoring a student on: {self.topic}

STUDENT CONTEXT:
- Knowledge Level : {self.knowledge_level}
- Learning Style  : {self.learning_style} — {style.get('description', '')}
"""
        return self._make_agent(prompt, temperature=0.7)

    def resource_finder_agent(self) -> Any:
        prompt = f"""{self._persona('resource_finder')}

You are finding learning resources for: {self.topic}

STUDENT PREFERENCES:
- Knowledge Level : {self.knowledge_level}
- Learning Style  : {self.learning_style}
- Learning Goal   : {self.learning_goal}
"""
        return self._make_agent(prompt, temperature=0.6, use_search=True)

    def summarizer_agent(self) -> Any:
        prompt = f"""{self._persona('summarizer')}

You are summarising content for a student learning: {self.topic}
Student level: {self.knowledge_level}
Be comprehensive, clear, and well-structured.
"""
        return self._make_agent(prompt, temperature=0.4)

    def notes_agent(self) -> Any:
        prompt = f"""{self._persona('notes_writer')}

You are writing study notes for a student learning: {self.topic}
Student level: {self.knowledge_level}
Learning style: {self.learning_style}
Make notes scannable, comprehensive, and revision-friendly.
"""
        return self._make_agent(prompt, temperature=0.4)

    def rag_tutor_agent(self) -> Any:
        prompt = f"""{self._persona('tutor_agent')}

You are answering questions grounded STRICTLY in the student's uploaded documents.

RULES:
- Use ONLY information from the provided document excerpts
- IGNORE table of contents, index pages, and page number listings
- Focus on actual content paragraphs
- Quote directly from the text when possible
- If the answer is not in the excerpts, say: "This section wasn't retrieved. Try asking about a specific topic from that section instead."
- Do NOT use your general knowledge to fill gaps
- Student level: {self.knowledge_level}
"""
        return self._make_agent(prompt, temperature=0.4)