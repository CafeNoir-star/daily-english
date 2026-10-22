# -*- coding: utf-8 -*-
"""真源抽取模块的单元测试（纯离线，不联网）。

运行：
    python -m unittest discover -s test -p "test_sources.py" -v

覆盖三件最要命的事：
1. 逐字校验必须放过"标点/空白差异"，必须拦住"改写一个词"；
2. 内容红线过滤（自杀/伤亡/涉华政治）不能失效；
3. RSS 解析要吃得住 Guardian 那种 description 里带 HTML 的结构。
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import sources  # noqa: E402


ORIGINAL = (
    "UK inflation jumps to 3.5% on rising motor fuels costs. "
    "Petrol and diesel costs rise the most in four years, the Office for "
    "National Statistics said on Wednesday. The increase adds pressure on the "
    "Bank of England to keep interest rates higher for longer."
)


class CleanFragmentTests(unittest.TestCase):
    def test_strips_html_tags(self):
        raw = "<p>Case was detected</p><p>in a woman who travelled.</p>"
        self.assertEqual(
            sources.clean_fragment(raw),
            "Case was detected in a woman who travelled.",
        )

    def test_unescapes_entities_and_collapses_space(self):
        raw = "<p>A &amp; B</p>\n\n<p>C&nbsp;&nbsp;D</p>"
        self.assertEqual(sources.clean_fragment(raw), "A & B C D")

    def test_drops_script_and_style(self):
        raw = "<style>.a{color:red}</style><p>Real text here.</p><script>x=1</script>"
        self.assertEqual(sources.clean_fragment(raw), "Real text here.")

    def test_removes_space_before_punctuation(self):
        """标签剥离会留下 'asset .'，标点前空格是明显的机器痕迹。"""
        raw = "<p>is seen as its greatest asset<a href='#'>.</a> But funding</p>"
        self.assertEqual(
            sources.clean_fragment(raw),
            "is seen as its greatest asset. But funding",
        )

    def test_keeps_decimal_and_percent(self):
        self.assertEqual(
            sources.clean_fragment("<p>Inflation hit 3.5% in October.</p>"),
            "Inflation hit 3.5% in October.",
        )

    def test_empty_input(self):
        self.assertEqual(sources.clean_fragment(""), "")
        self.assertEqual(sources.clean_fragment(None), "")


class VerbatimTests(unittest.TestCase):
    def test_exact_match_passes(self):
        self.assertTrue(sources.is_verbatim(ORIGINAL, ORIGINAL))

    def test_subset_passes(self):
        snippet = "Petrol and diesel costs rise the most in four years,"
        self.assertTrue(sources.is_verbatim(snippet, ORIGINAL))

    def test_curly_quotes_and_dashes_are_normalized(self):
        original = "The report\u2019s author said \u201cit is fine\u201d \u2014 really."
        snippet = "The report's author said \"it is fine\" - really."
        self.assertTrue(sources.is_verbatim(snippet, original))

    def test_extra_whitespace_passes(self):
        self.assertTrue(sources.is_verbatim("UK inflation   jumps to 3.5%", ORIGINAL))

    def test_rewritten_word_is_rejected(self):
        snippet = "UK inflation climbs to 3.5% on rising motor fuels costs."
        self.assertFalse(sources.is_verbatim(snippet, ORIGINAL))

    def test_reordered_sentences_rejected(self):
        snippet = (
            "Petrol and diesel costs rise the most in four years. "
            "UK inflation jumps to 3.5% on rising motor fuels costs."
        )
        self.assertFalse(sources.is_verbatim(snippet, ORIGINAL))

    def test_empty_rejected(self):
        self.assertFalse(sources.is_verbatim("", ORIGINAL))
        self.assertFalse(sources.is_verbatim(ORIGINAL, ""))


class RejectionTests(unittest.TestCase):
    # 够长的真实风格正文（> 380 字符），用于测试内容红线
    LONG = ORIGINAL + (
        " Economists said the figures were driven by higher fuel prices and "
        "a weaker pound. Retailers warned that costs would keep climbing into "
        "the winter, while unions called for targeted support for low-income "
        "households. The chancellor is expected to respond in next month's "
        "budget statement, which analysts will watch closely for any change "
        "in the fiscal rules."
    )

    def test_clean_article_accepted(self):
        self.assertIsNone(sources.rejection_reason("UK inflation jumps to 3.5%", self.LONG))

    def test_too_short_rejected(self):
        self.assertIn("too-short", sources.rejection_reason("t", "Short one. Two."))

    def test_too_long_rejected(self):
        text = "This is a sentence. " * 200
        self.assertIn("too-long", sources.rejection_reason("t", text))

    def test_suicide_blocked(self):
        text = self.LONG + " The charity warned about suicide risk among teenagers."
        self.assertIn("blocked", sources.rejection_reason("t", text))

    def test_violence_blocked(self):
        text = self.LONG + " Police said the man was killed at the scene."
        self.assertIn("blocked", sources.rejection_reason("t", text))

    def test_china_related_blocked(self):
        text = self.LONG + " The policy mirrors measures taken in China last year."
        self.assertIn("politics", sources.rejection_reason("t", text))

    def test_deadline_not_blocked_by_dead(self):
        """'deadline' 里含 'dead'，但不能被误伤。"""
        text = self.LONG + " The deadline for applications is Friday."
        self.assertIsNone(sources.rejection_reason("t", text))

    def test_newsletter_noise_rejected(self):
        text = self.LONG + " Sign up to our daily newsletter for more."
        self.assertIn("noise", sources.rejection_reason("t", text))

    def test_refugee_first_person_narrative_rejected(self):
        """2026-10-22 漏网的真实案例：全文没有 war/killed，靠这两个词拦不住。"""
        text = (
            "Nine years ago, I was forced to flee my home in Maungdaw township, Rakhine "
            "state, Myanmar. I was 13 years old. I remember how quickly an average day "
            "turned into a day when life felt extinguished, leaving behind the place where "
            "I grew up with my family. Even now, when I go to sleep, what comes into my "
            "mind is the memory of that journey, the fear of not knowing what awaited me. "
            "It took three days to reach refuge."
        )
        reason = sources.rejection_reason("A refugee's story", text)
        assert reason is not None, "难民第一人称叙述必须被拦下"
        assert "blocked" in reason or "politics" in reason, f"应命中红线，实际 {reason}"

    def test_flee_alone_rejected(self):
        text = self.LONG + " Thousands were forced to flee the region overnight."
        self.assertIn("blocked", sources.rejection_reason("t", text))

    def test_geopolitical_region_rejected(self):
        text = self.LONG + " The agreement covers rebuilding work in Ukraine."
        self.assertIn("politics", sources.rejection_reason("t", text))

    def test_climate_catastrophe_language_rejected(self):
        text = self.LONG + " Scientists warn of a climate catastrophe within decades."
        self.assertIn("blocked", sources.rejection_reason("t", text))

    def test_normal_business_news_not_rejected(self):
        """10-24 那种能源商业新闻只是提了一句 election manifesto，不该被误伤。"""
        text = (
            "The UK government has approved the controversial Jackdaw gasfield in the North "
            "Sea, a widely expected move that will nonetheless dismay environmental "
            "campaigners and a number of Labour MPs. While Labour's 2024 election manifesto "
            "committed to a ban on new drilling licences in the North Sea, the companies "
            "behind Jackdaw and the Rosebank oilfield project, which is being decided on "
            "separately, have sought environmental approval for existing licences. Analysts "
            "said the decision would keep household energy bills stable into next winter."
        )
        assert sources.rejection_reason("UK approves Jackdaw gasfield", text) is None

    def test_too_few_sentences_rejected(self):
        text = "x" * 400
        self.assertEqual(sources.rejection_reason("t", text), "too-few-sentences")


RSS_SAMPLE = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>UK inflation jumps to 3.5%</title>
    <link>https://www.theguardian.com/business/2026/oct/21/inflation</link>
    <pubDate>Wed, 21 Oct 2026 08:00:00 GMT</pubDate>
    <description><![CDATA[<p>Petrol and diesel costs rise.</p><p>The increase adds pressure.</p>]]></description>
  </item>
  <item>
    <title>Second story</title>
    <link>https://example.test/two</link>
    <pubDate>Wed, 21 Oct 2026 09:00:00 GMT</pubDate>
    <description>Plain text description.</description>
  </item>
</channel></rss>
"""


class ParseFeedTests(unittest.TestCase):
    def test_parses_items(self):
        items = sources.parse_feed(RSS_SAMPLE, "The Guardian")
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["source"], "The Guardian")
        self.assertEqual(items[0]["title"], "UK inflation jumps to 3.5%")
        self.assertEqual(
            items[0]["link"], "https://www.theguardian.com/business/2026/oct/21/inflation"
        )
        self.assertEqual(
            items[0]["text"], "Petrol and diesel costs rise. The increase adds pressure."
        )

    def test_candidate_word_count(self):
        cand = sources.Candidate(
            source="The Guardian", title="t", link="l", published="", text=ORIGINAL
        )
        self.assertEqual(cand.words, len(ORIGINAL.split()))


class StripTailTests(unittest.TestCase):
    def test_strips_continue_reading(self):
        raw = "The car could go from 0 to 60mph in under a second. Continue reading..."
        self.assertEqual(
            sources.strip_tail(raw),
            "The car could go from 0 to 60mph in under a second.",
        )

    def test_strips_read_more_and_full_story(self):
        self.assertEqual(sources.strip_tail("Body text. Read more…"), "Body text.")
        self.assertEqual(sources.strip_tail("Body text. Read the full story..."), "Body text.")

    def test_keeps_normal_text(self):
        text = "Officials said the overpass cut collisions by 91%."
        self.assertEqual(sources.strip_tail(text), text)


class FetchFailureTests(unittest.TestCase):
    def test_bad_xml_returns_error_not_raise(self):
        items, error = sources.fetch_feed("https://example.invalid/rss", "X", timeout=1)
        self.assertEqual(items, [])
        self.assertTrue(error)


if __name__ == "__main__":
    unittest.main(verbosity=2)
