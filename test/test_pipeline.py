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


class EnrichPendingTests(PipelineTestCase):
    """待补词队列：解析 LLM 返回、过滤无效项、CLI 开关。"""

    def test_parse_word_payload_maps_fields(self):
        raw = {
            "results": [
                {
                    "word": "Beacon",
                    "phonetic": "/ˈbiːkən/",
                    "pos": "n.",
                    "definition": "灯塔",
                    "example_sentence": "A beacon guided the ship.",
                    "example_translation": "灯塔指引着船只。",
                    "memory_tips": {"root_analysis": "bea", "mnemonic": "灯光"},
                }
            ]
        }
        rows = pipeline.parse_word_payload(raw)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["word"], "beacon", "单词应统一小写")
        self.assertEqual(row["definition"], "灯塔")
        self.assertEqual(row["phonetic"], "/ˈbiːkən/")
        self.assertEqual(row["audio_url"], "/audio/vocab_beacon.mp3")
        self.assertEqual(row["memory_tips"]["mnemonic"], "灯光")

    def test_parse_word_payload_skips_entries_without_definition(self):
        raw = {"results": [{"word": "alpha", "definition": ""}, {"word": "", "definition": "有释义"}]}
        self.assertEqual(pipeline.parse_word_payload(raw), [])

    def test_parse_word_payload_accepts_words_key(self):
        raw = {"words": [{"word": "loop", "definition": "循环"}]}
        rows = pipeline.parse_word_payload(raw)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["word"], "loop")

    def test_parse_word_payload_handles_garbage(self):
        self.assertEqual(pipeline.parse_word_payload(None), [])
        self.assertEqual(pipeline.parse_word_payload({"results": "not-a-list"}), [])

    def test_fetch_pending_words_reads_queue(self):
        pipeline.TOKEN = "test-token"
        captured = {}

        def fake_request_json(method, url, **kwargs):
            captured["url"] = url
            captured["params"] = kwargs.get("params")
            return [{"word": "beacon"}, {"word": "loop"}]

        with patch.object(pipeline, "request_json", side_effect=fake_request_json):
            words = pipeline.fetch_pending_words(10)

        self.assertEqual(words, ["beacon", "loop"])
        self.assertIn("pending_words", captured["url"])
        self.assertEqual(captured["params"]["limit"], 10)

    def test_cli_accepts_enrich_pending(self):
        with patch.object(sys, "argv", ["pipeline.py", "--enrich-pending"]):
            args = pipeline.parse_args()
        self.assertTrue(args.enrich_pending)


if __name__ == "__main__":
    unittest.main()

class DayIndexTests(PipelineTestCase):
    """规划阶段只需要日期，避免拉取整天的正文与句子数组。"""

    def test_fetch_day_index_selects_only_id_and_date(self):
        captured = {}

        def fake_request_json(method, url, **kwargs):
            captured["url"] = url
            captured["params"] = kwargs.get("params")
            return [{"id": 1, "date": "2026-10-20"}]

        with patch.object(pipeline, "request_json", side_effect=fake_request_json):
            rows = pipeline.fetch_day_index(auth=False)

        self.assertEqual(rows, [{"id": 1, "date": "2026-10-20"}])
        self.assertIn("daily_sentences", captured["url"])
        self.assertEqual(captured["params"]["select"], "id,date", "规划阶段只应取 id 和 date")

    def test_planning_uses_light_index(self):
        src = Path(pipeline.__file__).read_text(encoding="utf-8")
        self.assertIn("fetch_day_index(auth=True)", src, "主流程规划阶段应使用轻量索引")
        self.assertIn("fetch_day_index(auth=False)", src, "匿名规划阶段应使用轻量索引")
