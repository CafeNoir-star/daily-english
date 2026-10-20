#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""edge-tts 单条合成脚本。

用法:
    python tts.py --text "Hello world." --out audio/demo.mp3
    python tts.py --text "Hello" --out demo.mp3 --voice en-US-JennyNeural --rate +0%

退出码 0 表示成功，非 0 表示失败（方便 Node / shell 调用）。
"""

import argparse
import asyncio
import sys
from pathlib import Path

import edge_tts

DEFAULT_VOICE = "en-US-JennyNeural"


async def synthesize(text: str, out_path: Path, voice: str, rate: str) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")

    communicate = edge_tts.Communicate(text, voice, rate=rate)
    await communicate.save(str(tmp_path))

    if not tmp_path.exists() or tmp_path.stat().st_size < 500:
        tmp_path.unlink(missing_ok=True)
        raise RuntimeError("edge-tts returned an empty audio file")

    tmp_path.replace(out_path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate one MP3 with edge-tts")
    parser.add_argument("--text", required=True, help="text to synthesize")
    parser.add_argument("--out", required=True, help="output mp3 path")
    parser.add_argument("--voice", default=DEFAULT_VOICE, help="edge-tts voice name")
    parser.add_argument("--rate", default="+0%", help="speech rate, e.g. +0%% or -10%%")
    args = parser.parse_args()

    text = args.text.strip()
    if not text:
        print("empty text", file=sys.stderr)
        return 2
    if len(text) > 2000:
        print("text too long (max 2000 chars)", file=sys.stderr)
        return 2

    try:
        asyncio.run(synthesize(text, Path(args.out), args.voice, args.rate))
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        print(f"tts failed: {exc}", file=sys.stderr)
        return 1

    print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
