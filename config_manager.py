"""
StudyAI — ConfigManager
Loads prompts.yaml and exposes helpers used by the Flask app and agents.
"""
import yaml


class ConfigManager:
    def __init__(self, config_file: str = "prompts.yaml"):
        with open(config_file, "r") as f:
            self._cfg = yaml.safe_load(f)

    # ── Subject categories ─────────────────────────────────────────────────
    def get_all_subject_categories(self) -> list:
        return list(self._cfg.get("subject_categories", {}).keys())

    def get_subject_category_info(self, category: str) -> dict | None:
        return self._cfg.get("subject_categories", {}).get(category)

    # ── Knowledge levels ───────────────────────────────────────────────────
    def get_all_knowledge_levels(self) -> list:
        return list(self._cfg.get("knowledge_levels", {}).keys())

    def get_knowledge_level_info(self, level: str) -> dict | None:
        return self._cfg.get("knowledge_levels", {}).get(level)

    # ── Learning styles ────────────────────────────────────────────────────
    def get_all_learning_styles(self) -> list:
        return list(self._cfg.get("learning_styles", {}).keys())

    def get_learning_style_info(self, style: str) -> dict | None:
        return self._cfg.get("learning_styles", {}).get(style)

    # ── Prompts ────────────────────────────────────────────────────────────
    def get_prompt(self, key: str) -> str:
        return self._cfg.get("prompts", {}).get(key, {}).get("base", "")

    def get_persona(self, key: str) -> str:
        return self._cfg.get("personas", {}).get(key, {}).get("system_prompt", "")

    # ── Convenience: return everything bundled ─────────────────────────────
    def get_all_config(self) -> dict:
        return {
            "categories":      dict(self._cfg.get("subject_categories", {})),
            "knowledge_levels": dict(self._cfg.get("knowledge_levels", {})),
            "learning_styles":  dict(self._cfg.get("learning_styles", {})),
        }