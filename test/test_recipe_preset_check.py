"""herdr-artifact's publish check refuses a form field's preset value that doesn't fit its kind, as core/recipe.js's
problems() does (SHEP-70, upstream #1212): a select's value must be one of its options, a checkbox's true or false,
a text's words."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import importlib.machinery
import importlib.util
import json
import os
import shutil
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


A = load("herdr_artifact_preset_under_test", os.path.join(ROOT, "mods", "artifacts", "bin", "herdr-artifact"))


class PresetValues(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="recipe-preset-")
        self.addCleanup(shutil.rmtree, self.dir, True)

    def problems(self, *fields):
        with open(os.path.join(self.dir, "recipe.json"), "w") as f:
            json.dump({"recipe": 1, "blocks": [{"type": "form", "fields": list(fields)}]}, f)
        return A.recipe_problems(self.dir, ["recipe.json"])

    def test_values_that_fit_pass(self):
        self.assertEqual(self.problems(
            {"name": "a", "kind": "select", "options": ["Keep", "Drop"], "value": "Drop"},
            {"name": "b", "kind": "checkbox", "value": False},
            {"name": "c", "kind": "textarea", "value": ""},
            {"name": "d", "value": "no kind is text"},
            {"name": "e", "kind": "select", "options": ["x"]}), [])

    def test_values_that_dont_fit_are_refused_in_words(self):
        self.assertEqual(self.problems({"name": "plan", "kind": "select", "options": ["Keep", "Drop"], "value": "Cancel"}),
                         ['block 1 (form): field "plan": value must be one of its options ("Keep", "Drop").'])
        self.assertIn("it has none", self.problems({"name": "p", "kind": "select", "value": "x"})[0])
        self.assertIn("true or false", self.problems({"name": "ok", "kind": "checkbox", "value": "yes"})[0])
        self.assertIn("must be words", self.problems({"name": "t", "kind": "text", "value": 3})[0])
        # 1 isn't the option true, as in JavaScript's includes()
        self.assertEqual(len(self.problems({"name": "n", "kind": "select", "options": [True], "value": 1})), 1)


if __name__ == "__main__":
    unittest.main()
