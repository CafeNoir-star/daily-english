# -*- coding: utf-8 -*-
"""B 方案（Actions 只读语料、只生成音频）的单元测试。

运行：
    python -m unittest discover -s test -p "test_pipeline.py" -v
"""

import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pipeline  # noqa: E402


class PipelineTestCase(unittest.TestCase):
    def setUp(self):
        pipeline.WB_KEY = "wbpk_test"
        pipeline.WB_ENDPOINT = "https://example.test"
        pipeline.TOKEN = ""

    def _capture_headers(self, rows=None):
        captured = {}

        def fake_request_json(method, url, **kwargs):
            captured["method"] = method
            captured["url"] = url
            captured["headers"] = kwargs.get("headers") or {}
            return rows if rows is not None else []

        return captured, fake_request_json


class AnonymousReadTests(PipelineTestCase):
    def test_fetch_days_defaults_to_anonymous(self):
        captured, fake = self._capture_headers()
        with patch.object(pipeline, "request_json", side_effect=fake):
            pipeline.fetch_days()

        headers = captured["headers"]
        self.assertIn("x-wb-webapp-access-key", headers)
        self.assertNotIn("Authorization", headers)

    def test_fetch_words_defaults_to_anonymous(self):
        captured, fake = self._capture_headers()
        with patch.object(pipeline, "request_json", side_effect=fake):
            pipeline.fetch_words()

        self.assertNotIn("Authorization", captured["headers"])

    def test_fetch_days_with_auth_sends_bearer_token(self):
        pipeline.TOKEN = "tok123"
        captured, fake = self._capture_headers()
        with patch.object(pipeline, "request_json", side_effect=fake):
            pipeline.fetch_days(auth=True)

        self.assertEqual(captured["headers"]["Authorization"], "Bearer tok123")


class CoverageTests(PipelineTestCase):
    def test_coverage_fails_when_future_days_insufficient(self):
        today = datetime.now(pipeline.TZ).date()
        rows = [{"date": (today + timedelta(days=1)).isoformat()}]

        ok, latest = pipeline.check_coverage(rows, min_future_days=3)

        self.assertFalse(ok)
        self.assertEqual(latest, today + timedelta(days=1))

    def test_coverage_passes_when_enough_future_days(self):
        today = datetime.now(pipeline.TZ).date()
        rows = [{"date": (today + timedelta(days=3)).isoformat()}]

        ok, latest = pipeline.check_coverage(rows, min_future_days=3)

        self.assertTrue(ok)
        self.assertEqual(latest, today + timedelta(days=3))

    def test_coverage_fails_when_table_empty(self):
        ok, latest = pipeline.check_coverage([], min_future_days=2)

        self.assertFalse(ok)
        self.assertIsNone(latest)


class CliTests(PipelineTestCase):
    def test_cli_defaults_to_audio_only(self):
        args = pipeline.parse_args([])

        self.assertFalse(args.with_corpus)
        self.assertEqual(args.fail_if_stale, 0)

    def test_cli_accepts_with_corpus(self):
        args = pipeline.parse_args(["--with-corpus"])

        self.assertTrue(args.with_corpus)

    def test_cli_accepts_fail_if_stale(self):
        args = pipeline.parse_args(["--fail-if-stale", "2"])

        self.assertEqual(args.fail_if_stale, 2)


if __name__ == "__main__":
    unittest.main()
