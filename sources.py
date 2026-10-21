"""真实英文语料源：从公开 RSS 抽取真实段落，替代 LLM 从零写作。

设计原则
--------
1. **只用 RSS 的 <description>**：这是发布方主动通过 RSS 分发的摘要区块，
   不抓文章页正文，降低版权与合规风险；每条候选都带原始链接，出处可核对。
2. **文本原样保留**：本模块不做任何改写、润色、拼接。下游必须用
   ``is_verbatim()`` 逐字校验 LLM 返回的段落确实出自原文，杜绝"二次创作"。
3. **多源 + 单源失败不影响整体**：任一个 feed 超时/解析失败只跳过该源。

对外只暴露 ``collect_candidates()`` 和 ``is_verbatim()``。
"""

from __future__ import annotations

import html
import os
import re
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

USER_AGENT = "DailyEnglishLearningBot/1.0 (personal study; low volume)"

# 主源：Guardian 的职场/科技/科学板块，恰好是"外企沟通"人群最常读的题材。
# Guardian 的 RSS <description> 直接给出正文开头 3-5 段（500-1100 字符），
# 不需要再抓文章页，这是选它作主源的关键原因。
#
# 为什么没有第二家：实测 BBC(52/52)、Ars Technica(20/20)、MIT News(50/50)、
# The Conversation(50/50) 的 description 都只有 100-200 字符（一两句导语），
# ScienceDaily、Phys.org 也只有零星几条够长。Guardian 的全文式摘要是个特例。
# 因此冗余靠"同一家的更多板块"来堆，而不是引入第二个只会贡献 0 条的源。
FEEDS: tuple[dict[str, str], ...] = (
    {"source": "The Guardian", "url": "https://www.theguardian.com/uk/business/rss"},
    {"source": "The Guardian", "url": "https://www.theguardian.com/uk/technology/rss"},
    {"source": "The Guardian", "url": "https://www.theguardian.com/science/rss"},
    {"source": "The Guardian", "url": "https://www.theguardian.com/environment/rss"},
    {"source": "The Guardian", "url": "https://www.theguardian.com/education/rss"},
    {"source": "The Guardian", "url": "https://www.theguardian.com/society/rss"},
    {"source": "The Guardian", "url": "https://www.theguardian.com/money/rss"},
    {"source": "The Guardian", "url": "https://www.theguardian.com/media/rss"},
    {"source": "The Guardian", "url": "https://www.theguardian.com/books/rss"},
    {"source": "The Guardian", "url": "https://www.theguardian.com/global-development/rss"},
)

# 硬红线：出现即整条丢弃（暴力/伤亡/性/自残/灾难/疫情）。
# 用词边界匹配，避免 "deadline" 被 "dead" 误伤。
HARD_BLOCK = (
    "suicide", "suicidal", "self-harm", "self harm",
    "killed", "killing", "dead", "death", "died", "dies", "dying",
    "murder", "murderer", "homicide", "manslaughter",
    "massacre", "genocide", "torture", "rape", "raped", "rapist",
    "sexual assault", "paedophile", "pedophile", "child abuse",
    "abuse", "assault", "assaulted", "gunman", "shooting", "shooter", "shot dead",
    "stabbed", "stabbing", "bomb", "bombing", "bomber", "explosion", "blast",
    "terrorism", "terrorist", "terror attack", "hostage", "beheaded", "beheading",
    "execution", "wounded", "corpse", "body found", "fatal",
    "plane crash", "crash killed", "earthquake", "tsunami", "famine",
    "epidemic", "outbreak", "ebola", "pandemic", "vaccine scare",
    "war", "wars", "airstrike", "air strike", "missile", "troops", "militant",
)

# 中国相关一律跳过：这是给中文用户看的语料，不碰任何涉华政治议题。
POLITICS_BLOCK = (
    "china", "chinese", "beijing", "taiwan", "hong kong", "xinjiang", "tibet",
    "xi jinping", "communist party",
)

# 推广/导航语，出现在 RSS 摘要里会污染正文，命中则整条丢弃。
NOISE = (
    "sign up to", "sign up for", "subscribe to", "newsletter",
    "this article was amended", "read more", "follow us on",
    "listen to the podcast", "brought to you by",
)

MIN_TEXT_CHARS = 380   # 少于这个长度凑不出 3-5 句连贯正文
MAX_TEXT_CHARS = 2200  # 过长会稀释挑段命中率，也让 prompt 无谓变长


@dataclass
class Candidate:
    """一条候选真实段落。"""

    source: str
    title: str
    link: str
    published: str
    text: str
    words: int = field(default=0)

    def __post_init__(self) -> None:
        self.words = len(self.text.split())


def clean_fragment(fragment: str) -> str:
    """把 RSS 里的 HTML 片段压成纯文本。"""
    if not fragment:
        return ""
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", fragment)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = html.unescape(text)
    text = text.replace("\u200b", "").replace("\ufeff", "").replace("\xa0", " ")
    text = re.sub(r"\s+", " ", text).strip()
    # 标签剥离后会留下"asset ."这种标点前空格。中文读者一眼就看出是机器处理的，
    # 而这段文字要当作"真人写的英语"给人看，必须抹掉。
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    return text


# RSS 摘要末尾常挂着站内导航语，混进精读段落会很难看（"…had thrusters. Continue
# reading..."），在清洗阶段就直接切掉，而不是指望 LLM 每次都记得排除。
TAIL_NOISE = (
    re.compile(r"\s*Continue reading(\.\.\.|…)?\s*$", re.IGNORECASE),
    re.compile(r"\s*Read more(\.\.\.|…)?\s*$", re.IGNORECASE),
    re.compile(r"\s*Read the full (story|article)(\.\.\.|…)?\s*$", re.IGNORECASE),
    re.compile(r"\s*Sign up (to|for) .*$", re.IGNORECASE),
)


def strip_tail(text: str) -> str:
    """去掉摘要末尾的站内导航语。"""
    out = text
    for pattern in TAIL_NOISE:
        out = pattern.sub("", out)
    return out.strip()


def normalize_for_match(text: str) -> str:
    """归一化用于逐字比对：只抹平标点与空白差异，不动任何字母。"""
    text = (text or "")
    text = text.replace("\u2019", "'").replace("\u2018", "'")
    text = text.replace("\u201c", '"').replace("\u201d", '"')
    text = text.replace("\u2014", "-").replace("\u2013", "-")
    text = text.replace("\u00a0", " ").replace("\u200b", "")
    return re.sub(r"\s+", " ", text).strip().lower()


def is_verbatim(snippet: str, source_text: str) -> bool:
    """LLM 返回的段落是否逐字出自原文（允许标点/空白归一化）。"""
    a = normalize_for_match(snippet)
    b = normalize_for_match(source_text)
    if not a or not b:
        return False
    return a in b


def _hits(text: str, terms: tuple[str, ...]) -> str | None:
    for term in terms:
        if re.search(rf"(?<![a-z]){re.escape(term)}(?![a-z])", text):
            return term
    return None


def rejection_reason(title: str, text: str) -> str | None:
    """返回丢弃原因；None 表示可用。"""
    if len(text) < MIN_TEXT_CHARS:
        return f"too-short({len(text)})"
    if len(text) > MAX_TEXT_CHARS:
        return f"too-long({len(text)})"
    blob = f"{title} {text}".lower()
    term = _hits(blob, HARD_BLOCK)
    if term:
        return f"blocked:{term}"
    term = _hits(blob, POLITICS_BLOCK)
    if term:
        return f"politics:{term}"
    term = _hits(blob, NOISE)
    if term:
        return f"noise:{term}"
    # 至少要能切出 3 句，否则凑不成一段精读
    if len(re.findall(r"[.!?](\s|$)", text)) < 3:
        return "too-few-sentences"
    return None


def parse_feed(xml_bytes: bytes, source: str) -> list[dict[str, str]]:
    """解析 RSS，返回原始条目（不做过滤）。"""
    root = ET.fromstring(xml_bytes)
    items: list[dict[str, str]] = []
    for node in root.findall(".//item"):
        items.append(
            {
                "source": source,
                "title": clean_fragment(node.findtext("title") or ""),
                "link": (node.findtext("link") or "").strip(),
                "published": (node.findtext("pubDate") or "").strip(),
                "text": strip_tail(clean_fragment(node.findtext("description") or "")),
            }
        )
    return items


def _build_opener() -> urllib.request.OpenerDirector:
    """构造 opener。

    生产环境（GitHub Actions 海外 runner）直连即可，不设任何变量；
    本机需要翻墙调试时可设 ``SOURCE_PROXY=http://127.0.0.1:10808``。
    显式指定代理可绕开系统代理（系统代理往往连不通境外站点）。
    """
    proxy = os.environ.get("SOURCE_PROXY", "").strip()
    if proxy:
        return urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy, "https": proxy})
        )
    return urllib.request.build_opener()


def fetch_feed(url: str, source: str, timeout: float = 15.0, opener=None):
    """抓一个 feed，返回 (items, error)。异常不外抛，交给调用方降级。"""
    client = opener or _build_opener()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with client.open(req, timeout=timeout) as resp:
            payload = resp.read()
            status = getattr(resp, "status", 200)
        if status != 200:
            return [], f"HTTP {status}"
        return parse_feed(payload, source), None
    except Exception as exc:  # noqa: BLE001 - 单源失败必须可降级
        return [], f"{type(exc).__name__}: {str(exc)[:90]}"


def collect_candidates(
    per_feed: int = 8,
    timeout: float = 15.0,
    log=print,
) -> list[Candidate]:
    """合并所有 feed 的可用候选，按 feed 顺序优先（Guardian 在前）。"""
    opener = _build_opener()
    out: list[Candidate] = []
    seen_links: set[str] = set()
    seen_titles: set[str] = set()

    for feed in FEEDS:
        items, error = fetch_feed(feed["url"], feed["source"], timeout=timeout, opener=opener)
        if error:
            log(f"  [source] {feed['url']} 不可达：{error}")
            continue
        kept = 0
        skipped: dict[str, int] = {}
        for item in items:
            if kept >= per_feed:
                break
            if not item["text"] or not item["link"]:
                continue
            if item["link"] in seen_links:
                continue
            title_key = normalize_for_match(item["title"])
            if title_key in seen_titles:
                continue
            reason = rejection_reason(item["title"], item["text"])
            if reason:
                key = reason.split("(")[0]
                skipped[key] = skipped.get(key, 0) + 1
                continue
            seen_links.add(item["link"])
            seen_titles.add(title_key)
            out.append(
                Candidate(
                    source=item["source"],
                    title=item["title"],
                    link=item["link"],
                    published=item["published"],
                    text=item["text"],
                )
            )
            kept += 1
        detail = f"，跳过 {skipped}" if skipped else ""
        log(f"  [source] {feed['source']} {feed['url'].rsplit('/', 2)[-2]} → 采纳 {kept} 条{detail}")

    return out
