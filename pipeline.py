#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""每日英语 - 音频同步流水线（B 方案）。

默认模式（B）：
    1. 匿名读取 daily_sentences / word_dictionary（只需 WB_KEY，不需要密码）
    2. 用 edge-tts 预生成 句子 / 全文 / 生词 MP3 到 audio/
    3. 写 audio/manifest.json（文本指纹，重复运行自动跳过）
    4. 由 GitHub Actions 提交回仓库，前端通过 jsDelivr / R2 读取

可选模式（A，--with-corpus）：
    登录 WorkBuddy → LLM 生成语料 → 写库 → 生成音频

用法：
    python pipeline.py                    # B：只同步音频（默认）
    python pipeline.py --fail-if-stale 2  # 语料不足 2 天时退出码 3
    python pipeline.py --with-corpus      # A：生成语料并写库
    python pipeline.py --force-audio      # 强制重生成所有音频
    python pipeline.py --from-export      # 从 data/export_*.json 全量回填

依赖：pip install -r requirements.txt
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

import edge_tts
import requests

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

WB_ENDPOINT = os.getenv("WB_ENDPOINT", "https://daily-english-38358.app.workbuddy.host").rstrip("/")
WB_KEY = os.getenv("WB_KEY", "").strip()
WB_EMAIL = os.getenv("WB_EMAIL", "").strip()
WB_PASSWORD = os.getenv("WB_PASSWORD", "")
WB_TOKEN = os.getenv("WB_TOKEN", "").strip()

LLM_MODEL = os.getenv("LLM_MODEL", "glm-5.3-flash")
LLM_TIMEOUT = int(os.getenv("LLM_TIMEOUT", "300"))

TTS_VOICE = os.getenv("TTS_VOICE", "en-US-JennyNeural")
TTS_RATE = os.getenv("TTS_RATE", "+0%")
TTS_CONCURRENCY = int(os.getenv("TTS_CONCURRENCY", "3"))
TTS_RETRIES = int(os.getenv("TTS_RETRIES", "4"))

AUDIO_DIR = Path(os.getenv("AUDIO_DIR", "audio"))
AUDIO_BASE = os.getenv("AUDIO_BASE", "").strip()
OUT_DIR = Path(os.getenv("OUT_DIR", "out"))

DEFAULT_DAYS = int(os.getenv("DAYS", "30"))
MAX_DAYS_PER_RUN = int(os.getenv("MAX_DAYS_PER_RUN", "14"))

TZ = timezone(timedelta(hours=8))
MANIFEST_PATH = AUDIO_DIR / "manifest.json"

TOPICS = [
    "科技与人工智能",
    "气候与环境",
    "健康与心理",
    "文化与教育",
    "经济与工作",
    "太空与探索",
    "城市与交通",
    "语言与沟通",
    "体育与坚持",
    "艺术与创造",
    "媒体与信息",
    "旅行与跨文化",
]

TOKEN = ""
DRY_RUN = False


def log(message: str) -> None:
    now = datetime.now(TZ).strftime("%H:%M:%S")
    print(f"[{now}] {message}", flush=True)


def warn(message: str) -> None:
    log(f"WARN  {message}")


def die(message: str) -> None:
    log(f"ERROR {message}")
    raise SystemExit(1)


# ---------------------------------------------------------------------------
# HTTP / WorkBuddy Cloud
# ---------------------------------------------------------------------------


def _base_headers(with_auth: bool = False) -> dict[str, str]:
    if not WB_KEY:
        die("缺少 WB_KEY（WorkBuddy 应用 publishableKey）")
    headers = {
        "x-wb-webapp-access-key": WB_KEY,
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if with_auth:
        if not TOKEN:
            die("未登录，缺少 access_token")
        headers["Authorization"] = f"Bearer {TOKEN}"
    return headers


def request_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    json_body: Any = None,
    timeout: int = 60,
    retries: int = 3,
) -> Any:
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            response = requests.request(
                method,
                url,
                headers=headers or _base_headers(with_auth=True),
                params=params,
                json=json_body,
                timeout=timeout,
            )
            if response.status_code >= 500:
                raise requests.HTTPError(f"{response.status_code}: {response.text[:200]}")
            if response.status_code >= 400:
                raise RuntimeError(f"HTTP {response.status_code}: {response.text[:400]}")
            if not response.content:
                return None
            return response.json()
        except Exception as exc:  # noqa: BLE001 - retry boundary
            last_error = exc
            if attempt < retries:
                wait = min(2 ** attempt, 10)
                warn(f"{method} {url} 失败（第 {attempt} 次）：{exc}；{wait}s 后重试")
                time.sleep(wait)
    raise RuntimeError(f"{method} {url} 最终失败：{last_error}")


def login() -> str:
    global TOKEN
    if WB_TOKEN:
        TOKEN = WB_TOKEN
        log("使用环境变量中的 WB_TOKEN")
        return TOKEN

    if not WB_EMAIL or not WB_PASSWORD:
        die("缺少 WB_EMAIL / WB_PASSWORD（或提供 WB_TOKEN）")

    log(f"登录 WorkBuddy：{WB_EMAIL}")
    payload = {"username": WB_EMAIL, "password": WB_PASSWORD}
    data = request_json(
        "POST",
        f"{WB_ENDPOINT}/.cloud/auth/v1/signin",
        headers=_base_headers(with_auth=False),
        json_body=payload,
        timeout=30,
    )
    token = (data or {}).get("access_token")
    if not token:
        token = ((data or {}).get("data") or {}).get("access_token")
    if not token:
        die(f"登录响应中没有 access_token：{str(data)[:300]}")
    TOKEN = token
    log("登录成功")
    return TOKEN


def rest_get(table: str, params: dict[str, Any], auth: bool = False) -> list[dict[str, Any]]:
    data = request_json(
        "GET",
        f"{WB_ENDPOINT}/.cloud/database/rest/{table}",
        headers=_base_headers(with_auth=auth),
        params=params,
    )
    return data or []


def rest_insert(table: str, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    if DRY_RUN:
        log(f"[dry-run] 跳过写入 {table}：{len(rows)} 行")
        return
    headers = _base_headers(with_auth=True)
    headers["Prefer"] = "return=minimal"
    request_json(
        "POST",
        f"{WB_ENDPOINT}/.cloud/database/rest/{table}",
        headers=headers,
        json_body=rows,
        timeout=120,
    )


def rest_update(table: str, filters: dict[str, str], patch: dict[str, Any]) -> None:
    if DRY_RUN:
        log(f"[dry-run] 跳过更新 {table} {filters}")
        return
    headers = _base_headers(with_auth=True)
    headers["Prefer"] = "return=minimal"
    request_json(
        "PATCH",
        f"{WB_ENDPOINT}/.cloud/database/rest/{table}",
        headers=headers,
        params=filters,
        json_body=patch,
        timeout=60,
    )


# ---------------------------------------------------------------------------
# LLM
# ---------------------------------------------------------------------------


def llm_stream(messages: list[dict[str, str]], max_tokens: int = 8000) -> str:
    payload = {
        "model": LLM_MODEL,
        "messages": messages,
        "stream": True,
        "temperature": 0.7,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    headers = _base_headers(with_auth=False)
    headers["Accept"] = "text/event-stream"

    for attempt in range(1, 4):
        try:
            chunks: list[str] = []
            with requests.post(
                f"{WB_ENDPOINT}/.cloud/llm/chat/completions",
                headers=headers,
                json=payload,
                stream=True,
                timeout=(15, LLM_TIMEOUT),
            ) as response:
                if response.status_code >= 400:
                    raise RuntimeError(f"HTTP {response.status_code}: {response.text[:300]}")
                for raw_line in response.iter_lines(decode_unicode=False):
                    if not raw_line:
                        continue
                    line = raw_line.decode("utf-8", errors="replace")
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        event = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    choices = event.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    piece = delta.get("content")
                    if piece:
                        chunks.append(piece)
            text = "".join(chunks).strip()
            if not text:
                raise RuntimeError("LLM 返回空内容")
            return text
        except Exception as exc:  # noqa: BLE001 - retry boundary
            if attempt >= 3:
                raise
            wait = 5 * attempt
            warn(f"LLM 调用失败（第 {attempt} 次）：{exc}；{wait}s 后重试")
            time.sleep(wait)

    raise RuntimeError("LLM 调用失败")


def parse_json_object(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end <= start:
            raise
        value = json.loads(cleaned[start : end + 1])

    if isinstance(value, list):
        if not value:
            raise ValueError("LLM 返回空数组")
        value = value[0]
    if not isinstance(value, dict):
        raise ValueError(f"LLM 返回的不是 JSON 对象：{type(value)}")
    return value


# ---------------------------------------------------------------------------
# 语料生成
# ---------------------------------------------------------------------------


def normalize_ws(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def split_sentences(text: str) -> list[str]:
    text = normalize_ws(text)
    if not text:
        return []
    parts = re.split(r"(?<=[.!?])\s+", text)
    return [part.strip() for part in parts if part.strip()]


def generate_day(day: date, topic: str, recent_sources: Iterable[str]) -> dict[str, Any]:
    source_hint = "、".join(list(recent_sources)[-3:]) or "BBC News、TED、The Guardian"
    prompt = f"""生成 {day.isoformat()} 的英语精读语料，主题方向：{topic}。

要求：
1. english_text：4-5 句连贯的英文段落，80-110 词，表达自然，适合 intermediate 学习者。
2. chinese_translation：与英文逐句对应的自然中文翻译。
3. source：一个合理的来源名（可参考：{source_hint}），不要重复最近用过的来源。
4. source_type：news、ted、speech、literature 四选一。
5. difficulty：beginner、intermediate、advanced 三选一。
6. sentences：把 english_text 按句拆分的数组，必须与 english_text 完全一致。
7. key_words：8 个值得学习的单词或短语，每个包含：
   word、phonetic（IPA 音标）、pos（词性缩写）、definition（中文释义）、
   example_sentence（英文例句）、example_translation（中文翻译）、
   memory_tips（对象，含 root_analysis 和 mnemonic 两个字段）。
8. 不要涉及中国政治、宗教争议、暴力、色情等敏感内容。

只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释。格式：
{{"date":"{day.isoformat()}","english_text":"","chinese_translation":"","source":"","source_type":"news","difficulty":"intermediate","sentences":["",""],"key_words":[{{"word":"","phonetic":"","pos":"","definition":"","example_sentence":"","example_translation":"","memory_tips":{{"root_analysis":"","mnemonic":""}}}}]}}"""

    raw = llm_stream(
        [
            {
                "role": "system",
                "content": "你是严谨的英语学习内容编辑，只输出合法 JSON，不输出任何多余文字。",
            },
            {"role": "user", "content": prompt},
        ],
        max_tokens=8000,
    )
    return normalize_day(parse_json_object(raw), day)


def normalize_day(raw: dict[str, Any], day: date) -> dict[str, Any]:
    english = normalize_ws(str(raw.get("english_text") or ""))
    if len(english) < 120:
        raise ValueError(f"{day} 英文正文过短（{len(english)} 字符）")

    sentences = raw.get("sentences")
    if not isinstance(sentences, list) or len(sentences) < 3:
        sentences = split_sentences(english)
    sentences = [normalize_ws(str(item)) for item in sentences if normalize_ws(str(item))]

    if normalize_ws(" ".join(sentences)) != english:
        sentences = split_sentences(english)
    if len(sentences) < 3:
        raise ValueError(f"{day} 句子拆分失败（{len(sentences)} 句）")

    translation = normalize_ws(str(raw.get("chinese_translation") or ""))
    if not translation:
        raise ValueError(f"{day} 缺少中文翻译")
    if not re.search(r"[\u4e00-\u9fff]", translation):
        raise ValueError(f"{day} 中文翻译不含中文字符（疑似编码问题）")

    source_type = str(raw.get("source_type") or "news").strip().lower()
    if source_type not in {"news", "ted", "speech", "literature"}:
        source_type = "news"

    difficulty = str(raw.get("difficulty") or "intermediate").strip().lower()
    if difficulty not in {"beginner", "intermediate", "advanced"}:
        difficulty = "intermediate"

    words = normalize_words(raw.get("key_words"), day)

    return {
        "date": day.isoformat(),
        "english_text": english,
        "chinese_translation": translation,
        "source": normalize_ws(str(raw.get("source") or "BBC News"))[:80],
        "source_type": source_type,
        "difficulty": difficulty,
        "sentences": sentences,
        "key_words": words,
    }


def normalize_words(raw_words: Any, day: date) -> list[dict[str, Any]]:
    if not isinstance(raw_words, list):
        warn(f"{day} 没有返回 key_words")
        return []

    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for item in raw_words:
        if not isinstance(item, dict):
            continue
        word = normalize_ws(str(item.get("word") or "")).strip(" .,;:!?\"'")
        if not re.fullmatch(r"[A-Za-z][A-Za-z' -]{0,39}", word):
            continue
        key = word.lower()
        if key in seen:
            continue
        definition = normalize_ws(str(item.get("definition") or ""))
        if not definition or not re.search(r"[\u4e00-\u9fff]", definition):
            continue
        seen.add(key)

        tips = item.get("memory_tips")
        if not isinstance(tips, dict):
            tips = {}
        result.append(
            {
                "word": word,
                "phonetic": normalize_ws(str(item.get("phonetic") or "")),
                "pos": normalize_ws(str(item.get("pos") or "")),
                "definition": definition,
                "example_sentence": normalize_ws(str(item.get("example_sentence") or "")),
                "example_translation": normalize_ws(str(item.get("example_translation") or "")),
                "memory_tips": {
                    "root_analysis": normalize_ws(str(tips.get("root_analysis") or "")),
                    "mnemonic": normalize_ws(str(tips.get("mnemonic") or "")),
                },
                "difficulty_level": "intermediate",
            }
        )
        if len(result) >= 10:
            break
    return result


# ---------------------------------------------------------------------------
# 数据库
# ---------------------------------------------------------------------------


def fetch_days(auth: bool = False) -> list[dict[str, Any]]:
    rows = rest_get(
        "daily_sentences",
        {
            "select": "id,date,source,english_text,sentences",
            "order": "date.asc",
        },
        auth=auth,
    )
    log(f"库里已有 {len(rows)} 天语料")
    return rows


def fetch_words(auth: bool = False) -> list[dict[str, Any]]:
    rows = rest_get("word_dictionary", {"select": "id,word,audio_url"}, auth=auth)
    log(f"库里已有 {len(rows)} 个生词")
    return rows


def check_coverage(
    days: list[dict[str, Any]], min_future_days: int = 2
) -> tuple[bool, date | None]:
    """检查未来语料是否至少提前 min_future_days 天。"""
    parsed: list[date] = []
    for row in days:
        try:
            parsed.append(date.fromisoformat(str(row["date"])))
        except (KeyError, ValueError):
            continue
    if not parsed:
        return False, None

    latest = max(parsed)
    required = datetime.now(TZ).date() + timedelta(days=max(0, min_future_days))
    return latest >= required, latest


def next_id(rows: list[dict[str, Any]]) -> int:
    ids = [int(row["id"]) for row in rows if str(row.get("id", "")).isdigit()]
    return max(ids, default=0) + 1


def insert_days(days: list[dict[str, Any]], existing: list[dict[str, Any]]) -> int:
    existing_dates = {row["date"] for row in existing}
    next_value = next_id(existing)
    rows: list[dict[str, Any]] = []
    for day in days:
        if day["date"] in existing_dates:
            log(f"跳过已存在的日期 {day['date']}")
            continue
        rows.append(
            {
                "id": next_value,
                "date": day["date"],
                "english_text": day["english_text"],
                "chinese_translation": day["chinese_translation"],
                "source": day["source"],
                "source_type": day["source_type"],
                "difficulty": day["difficulty"],
                "sentences": day["sentences"],
            }
        )
        next_value += 1

    if not rows:
        return 0
    rest_insert("daily_sentences", rows)
    log(f"写入 daily_sentences：{len(rows)} 天")
    return len(rows)


def insert_words(days: list[dict[str, Any]], existing: list[dict[str, Any]]) -> int:
    existing_words = {str(row["word"]).lower() for row in existing}
    next_value = next_id(existing)
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()

    for day in days:
        for word in day.get("key_words", []):
            key = word["word"].lower()
            if key in existing_words or key in seen:
                continue
            seen.add(key)
            rows.append(
                {
                    "id": next_value,
                    "word": word["word"],
                    "phonetic": word["phonetic"],
                    "pos": word["pos"],
                    "definition": word["definition"],
                    "example_sentence": word["example_sentence"],
                    "example_translation": word["example_translation"],
                    "memory_tips": word["memory_tips"],
                    "audio_url": word_audio_url(word["word"]),
                    "difficulty_level": word["difficulty_level"],
                }
            )
            next_value += 1

    if not rows:
        return 0
    for start in range(0, len(rows), 50):
        rest_insert("word_dictionary", rows[start : start + 50])
    log(f"写入 word_dictionary：{len(rows)} 个生词")
    return len(rows)


# ---------------------------------------------------------------------------
# 音频
# ---------------------------------------------------------------------------


def safe_word(word: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", word.lower()).strip("_")


def word_audio_name(word: str) -> str:
    return f"vocab_{safe_word(word)}.mp3"


def word_audio_url(word: str) -> str:
    if AUDIO_BASE:
        return AUDIO_BASE.rstrip("/") + "/" + word_audio_name(word)
    return f"/audio/{word_audio_name(word)}"


def text_hash(text: str) -> str:
    return hashlib.sha1(normalize_ws(text).encode("utf-8")).hexdigest()[:16]


def load_manifest() -> dict[str, Any]:
    if not MANIFEST_PATH.exists():
        return {"version": 1, "files": {}}
    try:
        data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("files"), dict):
            return {"version": 1, "files": {}}
        return data
    except Exception:  # noqa: BLE001 - corrupted manifest should not block
        warn("manifest.json 解析失败，按空清单处理")
        return {"version": 1, "files": {}}


def save_manifest(files: dict[str, Any]) -> None:
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "generated_at": datetime.now(TZ).isoformat(timespec="seconds"),
        "voice": TTS_VOICE,
        "files": dict(sorted(files.items())),
    }
    tmp = MANIFEST_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(MANIFEST_PATH)


def build_audio_tasks(
    days: list[dict[str, Any]], words: list[dict[str, Any]]
) -> list[tuple[str, str]]:
    tasks: dict[str, str] = {}

    for day in days:
        sentences = day.get("sentences") or []
        if isinstance(sentences, str):
            try:
                sentences = json.loads(sentences)
            except json.JSONDecodeError:
                sentences = split_sentences(day.get("english_text", ""))
        for index, sentence in enumerate(sentences):
            name = f"{day['date']}_s{index}.mp3"
            tasks[name] = sentence
        if day.get("english_text"):
            tasks[f"{day['date']}_full.mp3"] = day["english_text"]

    for word in words:
        tasks.setdefault(word_audio_name(word["word"]), word["word"])

    return [(text, name) for name, text in tasks.items()]


async def synthesize_one(text: str, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    communicate = edge_tts.Communicate(text, TTS_VOICE, rate=TTS_RATE)
    await communicate.save(str(tmp))
    if not tmp.exists() or tmp.stat().st_size < 500:
        tmp.unlink(missing_ok=True)
        raise RuntimeError("empty audio")
    tmp.replace(path)


async def run_tts(tasks: list[tuple[str, str]], force: bool = False) -> dict[str, Any]:
    manifest = load_manifest()
    files: dict[str, Any] = dict(manifest.get("files") or {})
    semaphore = asyncio.Semaphore(max(1, TTS_CONCURRENCY))
    stats = {"generated": 0, "skipped": 0, "failed": 0}
    failed_tasks: list[tuple[str, str]] = []

    async def worker(text: str, name: str) -> None:
        path = AUDIO_DIR / name
        fingerprint = text_hash(text)
        record = files.get(name) or {}

        if (
            not force
            and path.exists()
            and path.stat().st_size > 500
            and (not record or record.get("h") == fingerprint)
        ):
            stats["skipped"] += 1
            return

        async with semaphore:
            for attempt in range(1, TTS_RETRIES + 1):
                try:
                    await synthesize_one(text, path)
                    files[name] = {
                        "h": fingerprint,
                        "bytes": path.stat().st_size,
                        "text": text[:120],
                    }
                    stats["generated"] += 1
                    return
                except Exception as exc:  # noqa: BLE001 - retry boundary
                    if attempt >= TTS_RETRIES:
                        stats["failed"] += 1
                        failed_tasks.append((text, name))
                        warn(f"TTS 失败 {name}：{exc}")
                        return
                    await asyncio.sleep(1.5 * attempt)

    total = len(tasks)
    log(f"音频任务：{total} 条（并发 {TTS_CONCURRENCY}）")
    batch = 200
    for start in range(0, total, batch):
        chunk = tasks[start : start + batch]
        await asyncio.gather(*(worker(text, name) for text, name in chunk))
        save_manifest(files)
        log(
            f"进度 {min(start + batch, total)}/{total}："
            f"新增 {stats['generated']}，跳过 {stats['skipped']}，失败 {stats['failed']}"
        )

    if failed_tasks:
        log(f"二次串行重试：{len(failed_tasks)} 条")
        still_failed = 0
        for text, name in failed_tasks:
            path = AUDIO_DIR / name
            try:
                await synthesize_one(text, path)
                files[name] = {
                    "h": text_hash(text),
                    "bytes": path.stat().st_size,
                    "text": text[:120],
                }
                stats["failed"] -= 1
                stats["generated"] += 1
            except Exception as exc:  # noqa: BLE001 - best effort
                still_failed += 1
                warn(f"二次重试仍失败 {name}：{exc}")
            await asyncio.sleep(1)
        log(f"二次重试完成，仍失败 {still_failed} 条")

    save_manifest(files)
    return stats


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def plan_dates(existing: list[dict[str, Any]], days: int) -> list[date]:
    """保持未来 N 天的滚动缓冲：补齐窗口内所有缺口，不无限往后堆。"""
    today = datetime.now(TZ).date()
    have: set[date] = set()
    for row in existing:
        try:
            have.add(date.fromisoformat(str(row["date"])))
        except ValueError:
            continue

    target_end = today + timedelta(days=max(1, days) - 1)
    window = [today + timedelta(days=offset) for offset in range((target_end - today).days + 1)]
    missing = [day for day in window if day not in have]

    if not missing:
        log(f"未来 {days} 天语料已齐全（{today} ~ {target_end}），本次无需生成")
        return []

    result = missing[:MAX_DAYS_PER_RUN]
    log(
        f"窗口内缺 {len(missing)} 天，本次生成 {len(result)} 天："
        f"{result[0]} ~ {result[-1]}（缓冲目标 {target_end}）"
    )
    return result


def generate_corpus(existing: list[dict[str, Any]], days: int) -> list[dict[str, Any]]:
    targets = plan_dates(existing, days)
    recent_sources: list[str] = [str(row.get("source") or "") for row in existing[-5:]]
    generated: list[dict[str, Any]] = []

    for index, day in enumerate(targets):
        topic = TOPICS[(len(existing) + index) % len(TOPICS)]
        log(f"生成 {day}（{topic}）")
        for attempt in range(1, 4):
            try:
                item = generate_day(day, topic, recent_sources)
                generated.append(item)
                recent_sources.append(item["source"])
                log(
                    f"  OK  {len(item['sentences'])} 句 / "
                    f"{len(item['english_text'])} 字符 / {len(item['key_words'])} 生词"
                )
                break
            except Exception as exc:  # noqa: BLE001 - retry boundary
                if attempt >= 3:
                    warn(f"  {day} 生成失败，跳过：{exc}")
                    break
                wait = 5 * attempt
                warn(f"  {day} 第 {attempt} 次失败：{exc}；{wait}s 后重试")
                time.sleep(wait)

    if DRY_RUN and generated:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        for item in generated:
            path = OUT_DIR / f"corpus-{item['date']}.json"
            path.write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"[dry-run] 语料已写入 {OUT_DIR}/")

    return generated


def load_export_rows(filename: str) -> list[dict[str, Any]]:
    path = Path("data") / filename
    if not path.exists():
        die(f"找不到 {path}")
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        raw = raw.get("data") or raw.get("rows") or []
    if not isinstance(raw, list):
        die(f"{path} 格式不正确")
    return raw


def load_export_days() -> list[dict[str, Any]]:
    rows = load_export_rows("export_daily_sentences.json")
    days: list[dict[str, Any]] = []
    for row in rows:
        sentences = row.get("sentences")
        if isinstance(sentences, str):
            try:
                sentences = json.loads(sentences)
            except json.JSONDecodeError:
                sentences = split_sentences(str(row.get("english_text") or ""))
        if not isinstance(sentences, list) or not sentences:
            sentences = split_sentences(str(row.get("english_text") or ""))
        days.append(
            {
                "date": row["date"],
                "english_text": row.get("english_text") or "",
                "sentences": sentences,
            }
        )
    log(f"从本地导出读取 {len(days)} 天语料")
    return days


def load_export_words() -> list[dict[str, Any]]:
    rows = load_export_rows("export_word_dictionary.json")
    words = [{"word": row["word"]} for row in rows if row.get("word")]
    log(f"从本地导出读取 {len(words)} 个生词")
    return words


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="每日英语语料与音频流水线")
    parser.add_argument(
        "--with-corpus",
        action="store_true",
        help="A 方案：生成语料并写库（需要 WB_EMAIL / WB_PASSWORD）；默认只同步音频",
    )
    parser.add_argument("--days", type=int, default=DEFAULT_DAYS, help="保持未来多少天的语料缓冲")
    parser.add_argument("--backfill", action="store_true", help="只为已有语料补音频，不生成新语料")
    parser.add_argument("--no-audio", action="store_true", help="跳过音频生成")
    parser.add_argument("--no-corpus", action="store_true", help="跳过语料生成")
    parser.add_argument("--force-audio", action="store_true", help="强制重生成所有音频")
    parser.add_argument("--dry-run", action="store_true", help="不写数据库")
    parser.add_argument(
        "--fail-if-stale",
        type=int,
        default=0,
        metavar="DAYS",
        help="未来语料不足 DAYS 天时以退出码 3 结束（用于告警）",
    )
    parser.add_argument(
        "--from-export",
        action="store_true",
        help="从 data/export_*.json 读取内容，只生成音频（首次全量回填用）",
    )
    return parser.parse_args(argv)


def main() -> int:
    global DRY_RUN

    args = parse_args()
    DRY_RUN = args.dry_run
    started = time.time()
    mode = "A（生成语料 + 写库）" if args.with_corpus else "B（只读语料 + 生成音频）"

    log("=" * 60)
    log(f"每日英语流水线启动｜模式 {mode}")
    log(f"voice={TTS_VOICE}  endpoint={WB_ENDPOINT}")
    log("=" * 60)

    if args.from_export:
        days = load_export_days()
        words = load_export_words()
        stats = asyncio.run(run_tts(build_audio_tasks(days, words), force=args.force_audio))
        log(
            f"音频回填完成：新增 {stats['generated']}，跳过 {stats['skipped']}，"
            f"失败 {stats['failed']}，用时 {int(time.time() - started)}s"
        )
        return 0

    if DRY_RUN:
        log("[dry-run] 跳过登录与数据库读取")
        existing_days: list[dict[str, Any]] = []
        existing_words: list[dict[str, Any]] = []
    elif args.with_corpus:
        login()
        existing_days = fetch_days(auth=True)
        existing_words = fetch_words(auth=True)
    else:
        log("匿名读取语料（不需要密码，不写数据库）")
        existing_days = fetch_days(auth=False)
        existing_words = fetch_words(auth=False)

    stale = False
    if args.fail_if_stale > 0 and not DRY_RUN:
        ok, latest = check_coverage(existing_days, args.fail_if_stale)
        if not ok:
            warn(f"语料覆盖不足：最新日期 {latest}，要求至少提前 {args.fail_if_stale} 天")
            stale = True

    new_days: list[dict[str, Any]] = []
    if args.with_corpus and not args.backfill and not args.no_corpus:
        new_days = generate_corpus(existing_days, args.days)
        if not new_days:
            log("本次没有新增语料（缓冲区已覆盖）")
        else:
            insert_days(new_days, existing_days)
            insert_words(new_days, existing_words)
    elif not args.with_corpus:
        log("跳过语料生成（由 WorkBuddy 定时任务负责）")

    if args.no_audio:
        log("按参数跳过音频生成")
    else:
        if DRY_RUN:
            all_days = list(new_days)
            all_words = [
                {"word": word["word"], "audio_url": ""}
                for row in new_days
                for word in row.get("key_words", [])
            ]
        else:
            all_days = fetch_days(auth=args.with_corpus)
            all_words = fetch_words(auth=args.with_corpus)

            # 新语料刚写入，避免重复构建同一批任务
            known_dates = {row["date"] for row in all_days}
            all_days.extend(row for row in new_days if row["date"] not in known_dates)
            known_words = {str(row["word"]).lower() for row in all_words}
            for row in new_days:
                for word in row.get("key_words", []):
                    if word["word"].lower() not in known_words:
                        all_words.append({"word": word["word"], "audio_url": ""})
                        known_words.add(word["word"].lower())

        tasks = build_audio_tasks(all_days, all_words)
        stats = asyncio.run(run_tts(tasks, force=args.force_audio))
        log(
            f"音频完成：新增 {stats['generated']}，跳过 {stats['skipped']}，"
            f"失败 {stats['failed']}"
        )
        if stats["failed"]:
            warn(f"有 {stats['failed']} 个音频失败，下次运行会自动重试")

    elapsed = int(time.time() - started)
    log(f"全部完成，用时 {elapsed}s")

    if stale:
        warn("语料不足，以退出码 3 结束（触发 GitHub Actions 失败告警）")
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
