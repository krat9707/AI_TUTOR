"""
StudyAI — Study Agents
Five specialized AI agents built on Agno (phidata).
Each agent has a focused persona and is tuned for its specific task.
"""

import os
import yaml


def _detect_framework():
    """Return 'agno' or 'phi' depending on what's installed."""
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
        "    Install one of these:\n"
        "      pip install agno\n"
        "    or\n"
        "      pip install phidata\n"
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

        self._cfg = self._load_config()

    # ── Config helpers ─────────────────────────────────────────────────────

    def _load_config(self) -> dict:
        # Use absolute path so it works regardless of cwd
        base = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(base, "prompts.yaml")
        with open(path, "r") as f:
            return yaml.safe_load(f)

    def _persona(self, key: str) -> str:
        return self._cfg.get("personas", {}).get(key, {}).get("system_prompt", "")

    def _style_info(self) -> dict:
        return self._cfg.get("learning_styles", {}).get(self.learning_style, {})

    # ── Model factory ──────────────────────────────────────────────────────

    def _get_model_safe(self, temperature: float = 0.7):
        if FRAMEWORK == "agno":
            if self.provider == "groq":
                from agno.models.groq import Groq
                return Groq(id=self.model_name, temperature=temperature)
            else:
                from agno.models.openai import OpenAIChat
                return OpenAIChat(id=self.model_name, temperature=temperature)
        else:
            if self.provider == "groq":
                from phi.model.groq import Groq
                return Groq(id=self.model_name, temperature=temperature)
            else:
                from phi.model.openai import OpenAIChat
                return OpenAIChat(id=self.model_name, temperature=temperature)

    def _make_agent(self, system_prompt: str, temperature: float = 0.7,
                    use_search: bool = False):
        model = self._get_model_safe(temperature)

        tools = []
        if use_search:
            try:
                if FRAMEWORK == "agno":
                    from agno.tools.duckduckgo import DuckDuckGoTools
                    tools = [DuckDuckGoTools()]
                else:
                    from phi.tools.duckduckgo import DuckDuckGo
                    tools = [DuckDuckGo()]
            except ImportError:
                print("⚠️  DuckDuckGo tool not available — resource search will use model knowledge only.")

        if FRAMEWORK == "agno":
            from agno.agent import Agent
            # agno uses 'instructions', not 'system_prompt'
            kwargs = dict(model=model, instructions=system_prompt, markdown=True)
            if tools:
                kwargs["tools"] = tools
            return Agent(**kwargs)
        else:
            from phi.agent import Agent
            # phidata uses 'system_prompt'
            kwargs = dict(model=model, system_prompt=system_prompt)
            if tools:
                kwargs["tools"] = tools
                kwargs["show_tool_calls"] = False
            return Agent(**kwargs)

    # ── Agents ─────────────────────────────────────────────────────────────

    def student_analyzer_agent(self):
        """
        Educational psychologist agent.
        Analyses the student's knowledge level, gaps, and learning needs.
        """
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

    def roadmap_creator_agent(self):
        """
        Curriculum designer agent.
        Creates a phased, milestone-based learning roadmap.
        """
        style = self._style_info()
        recs = style.get("recommendations", [])
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

    def quiz_generator_agent(self):
        """
        Assessment designer agent.
        Generates adaptive quizzes with explanations.
        """
        prompt = f"""{self._persona('quiz_generator')}

You are creating quizzes for a student learning: {self.topic}

STUDENT LEVEL : {self.knowledge_level}
LEARNING GOAL : {self.learning_goal}

Ensure all questions are appropriate for the student's level and
help them progress toward their stated goal.
"""
        return self._make_agent(prompt, temperature=0.5)

    def tutor_agent(self):
        """
        Patient tutor agent.
        Answers questions with step-by-step explanations and analogies.
        """
        style = self._style_info()
        prompt = f"""{self._persona('tutor_agent')}

You are tutoring a student on: {self.topic}

STUDENT CONTEXT:
- Knowledge Level : {self.knowledge_level}
- Learning Style  : {self.learning_style} — {style.get('description', '')}

Adapt every explanation to match their learning style and knowledge level.
Use analogies, examples, and step-by-step breakdowns.
"""
        return self._make_agent(prompt, temperature=0.7)

    def resource_finder_agent(self):
        """
        Research specialist agent with DuckDuckGo web search.
        Finds and curates high-quality learning resources.
        """
        style = self._style_info()
        prompt = f"""{self._persona('resource_finder')}

You are finding learning resources for: {self.topic}

STUDENT PREFERENCES:
- Knowledge Level : {self.knowledge_level}
- Learning Style  : {self.learning_style}
- Learning Goal   : {self.learning_goal}

Prioritise resources that match the {self.learning_style} learning style.
Include free resources wherever possible.
"""
        return self._make_agent(prompt, temperature=0.6, use_search=True)

    def rag_tutor_agent(self):
        """
        RAG-enabled tutor agent.
        Answers questions grounded in the student's uploaded documents.
        """
        prompt = f"""{self._persona('tutor_agent')}

You are tutoring a student on: {self.topic}
You have been given relevant excerpts from their own study materials as context.

IMPORTANT RULES:
- Base your answers primarily on the provided document context.
- If the context does not contain enough information, say so clearly.
- Cite or reference specific sections when relevant.
- Still explain concepts clearly for a {self.knowledge_level} level student.
"""
        return self._make_agent(prompt, temperature=0.6)