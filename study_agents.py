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
        model_name: str = "llama-3.3-70b-versatile",
        provider: str = "groq",
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
        self._system_prompt: str = ""

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
        from providers import get_api_key, PROVIDERS
        provider_cfg = PROVIDERS.get(self.provider, {})
        base_url = provider_cfg.get("base_url", "")
        api_key  = get_api_key(self.provider)

        if FRAMEWORK == "agno":
            if self.provider == "groq":
                from agno.models.groq import Groq  # type: ignore[import]
                return Groq(id=self.model_name, temperature=temperature)
            from agno.models.openai import OpenAIChat  # type: ignore[import]
            if base_url and api_key:
                return OpenAIChat(id=self.model_name, api_key=api_key,
                                  base_url=base_url, temperature=temperature)
            return OpenAIChat(id=self.model_name, temperature=temperature)
        else:
            if self.provider == "groq":
                from phi.model.groq import Groq  # type: ignore[import]
                return Groq(id=self.model_name, temperature=temperature)
            from phi.model.openai import OpenAIChat  # type: ignore[import]
            if base_url and api_key:
                return OpenAIChat(id=self.model_name, api_key=api_key,
                                  base_url=base_url, temperature=temperature)
            return OpenAIChat(id=self.model_name, temperature=temperature)

    def _get_search_tools(self) -> List[Any]:
        try:
            if FRAMEWORK == "agno":
                from agno.tools.duckduckgo import DuckDuckGoTools  # type: ignore[import]
                return [DuckDuckGoTools()]
            from phi.tools.duckduckgo import DuckDuckGo  # type: ignore[import]
            return [DuckDuckGo()]
        except ImportError:
            print("⚠️  DuckDuckGo not available")
            return []

    def _is_native_openai(self) -> bool:
        return self.provider == "openai"

    def _direct_chat(self, system_prompt: str, user_prompt: str, temperature: float = 0.7) -> str:
        """Bypass agno entirely — call API directly with role:system, not role:developer."""
        from providers import get_api_key, PROVIDERS
        from openai import OpenAI
        cfg      = PROVIDERS.get(self.provider, {})
        api_key  = get_api_key(self.provider)
        base_url = cfg.get("base_url", "")
        client   = OpenAI(api_key=api_key, base_url=base_url)
        resp = client.chat.completions.create(
            model=self.model_name,
            temperature=temperature,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_prompt},
            ],
        )
        return resp.choices[0].message.content or ""

    def _make_agent(self, system_prompt: str, temperature: float = 0.7, use_search: bool = False) -> Any:
        model = self._get_model(temperature)
        tools = self._get_search_tools() if use_search else []
        # Always store so _run_agent can use _direct_chat for non-OpenAI providers
        self._system_prompt = system_prompt

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

    # ── Agent factories ──────────────────────────────────────────────────────

    def tutor_agent(self) -> Any:
        style = self._style_info()
        prompt = (
            f"{self._persona('tutor_agent')}\n\n"
            f"You are tutoring a student on: {self.topic}\n\n"
            f"STUDENT CONTEXT:\n"
            f"- Knowledge Level : {self.knowledge_level}\n"
            f"- Learning Style  : {self.learning_style} — {style.get('description', '')}\n"
        )
        return self._make_agent(prompt, temperature=0.7)

    def rag_tutor_agent(self) -> Any:
        prompt = (
            f"{self._persona('tutor_agent')}\n\n"
            "You are answering questions grounded STRICTLY in the student's uploaded documents.\n\n"
            "RULES:\n"
            "- Use ONLY information from the provided document excerpts\n"
            "- IGNORE table of contents, index pages, and page number listings\n"
            "- Focus on actual content paragraphs\n"
            "- Quote directly from the text when possible\n"
            "- If the answer is not in the excerpts, say: "
            "\"This section wasn't retrieved. Try asking about a specific topic instead.\"\n"
            "- Do NOT use your general knowledge to fill gaps\n"
            f"- Student level: {self.knowledge_level}\n"
        )
        return self._make_agent(prompt, temperature=0.4)

    def summarizer_agent(self) -> Any:
        prompt = (
            f"{self._persona('summarizer')}\n\n"
            f"You are creating a summary for a student studying: {self.topic}\n\n"
            f"STUDENT CONTEXT:\n"
            f"- Knowledge Level: {self.knowledge_level}\n"
            f"- Learning Goal  : {self.learning_goal or 'general understanding'}\n"
        )
        return self._make_agent(prompt, temperature=0.5)

    def notes_agent(self) -> Any:
        prompt = (
            f"{self._persona('notes_agent')}\n\n"
            f"You are generating structured study notes for: {self.topic}\n\n"
            f"STUDENT CONTEXT:\n"
            f"- Knowledge Level: {self.knowledge_level}\n"
            f"- Learning Style : {self.learning_style}\n"
        )
        return self._make_agent(prompt, temperature=0.5)

    def quiz_generator_agent(self) -> Any:
        prompt = (
            f"{self._persona('quiz_generator')}\n\n"
            f"You are generating quiz questions about: {self.topic}\n\n"
            f"STUDENT CONTEXT:\n"
            f"- Knowledge Level: {self.knowledge_level}\n"
        )
        return self._make_agent(prompt, temperature=0.6)

    def roadmap_creator_agent(self) -> Any:
        prompt = (
            f"{self._persona('roadmap_creator')}\n\n"
            f"You are creating a learning roadmap for: {self.topic}\n\n"
            f"STUDENT CONTEXT:\n"
            f"- Knowledge Level: {self.knowledge_level}\n"
            f"- Learning Goal  : {self.learning_goal or 'master the subject'}\n"
            f"- Time Available : {self.time_available}\n"
        )
        return self._make_agent(prompt, temperature=0.6)

    def student_analyzer_agent(self) -> Any:
        prompt = (
            f"{self._persona('student_analyzer')}\n\n"
            f"You are analysing a student who wants to learn: {self.topic}\n\n"
            f"STUDENT PROFILE:\n"
            f"- Current Knowledge Level : {self.knowledge_level}\n"
            f"- Learning Goal           : {self.learning_goal}\n"
            f"- Time Available          : {self.time_available}\n"
            f"- Preferred Style         : {self.learning_style}\n"
        )
        return self._make_agent(prompt, temperature=0.3)

    def resource_finder_agent(self) -> Any:
        prompt = (
            f"{self._persona('resource_finder')}\n\n"
            f"You are finding learning resources for: {self.topic}\n\n"
            f"STUDENT PREFERENCES:\n"
            f"- Knowledge Level : {self.knowledge_level}\n"
            f"- Learning Style  : {self.learning_style}\n"
            f"- Learning Goal   : {self.learning_goal}\n"
        )
        return self._make_agent(prompt, temperature=0.6, use_search=True)