# -*- coding: utf-8 -*-
"""音频裁静音的单元测试（不依赖本机是否装了 ffmpeg，用 mock 验证行为）。

背景：edge-tts 产出的 mp3 尾部带约 0.9 秒静音，加上下一句开头 0.2 秒，
     两句之间会有 1.1 秒空白。生成后用 ffmpeg 裁掉首尾静音。

运行：
    python -m unittest discover -s test -p "test_trim_silence.py" -v
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pipeline  # noqa: E402


class TrimSilenceTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.path = Path(self.tmpdir.name) / "clip.mp3"
        self.path.write_bytes(b"\xff\xfb" + b"\x00" * 2000)  # 假装是一段音频

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_returns_false_when_ffmpeg_missing(self):
        """没装 ffmpeg 时不能报错，要安静地保留原文件（裁剪只是优化）。"""
        with patch.object(pipeline.shutil, "which", return_value=None):
            ok = pipeline.trim_silence(self.path)
        self.assertFalse(ok)
        self.assertTrue(self.path.exists(), "原文件必须保留")

    def test_skips_work_when_ffmpeg_missing(self):
        with patch.object(pipeline.shutil, "which", return_value=None):
            with patch.object(pipeline.subprocess, "run") as run:
                pipeline.trim_silence(self.path)
        run.assert_not_called()

    def test_replaces_file_on_success(self):
        def fake_run(cmd, **kwargs):
            # ffmpeg 会把结果写到 -i 之后指定的输出路径（最后一个参数）
            Path(cmd[-1]).write_bytes(b"\xff\xfb" + b"\x00" * 600)
            return MagicMock(returncode=0, stderr=b"")

        with patch.object(pipeline.shutil, "which", return_value="/usr/bin/ffmpeg"):
            with patch.object(pipeline.subprocess, "run", side_effect=fake_run):
                ok = pipeline.trim_silence(self.path)

        self.assertTrue(ok)
        self.assertLess(self.path.stat().st_size, 2100, "应把裁剪后的文件替换回去")
        leftovers = list(Path(self.tmpdir.name).glob("*.trim.mp3"))
        self.assertEqual(leftovers, [], "临时文件必须清理干净")

    def test_keeps_original_when_ffmpeg_fails(self):
        before = self.path.read_bytes()
        with patch.object(pipeline.shutil, "which", return_value="/usr/bin/ffmpeg"):
            with patch.object(pipeline.subprocess, "run", return_value=MagicMock(returncode=1, stderr=b"boom")):
                ok = pipeline.trim_silence(self.path)

        self.assertFalse(ok)
        self.assertEqual(self.path.read_bytes(), before, "失败时不能动原文件")
        self.assertEqual(list(Path(self.tmpdir.name).glob("*.trim.mp3")), [], "失败也要清理临时文件")

    def test_filter_trims_both_ends(self):
        """尾部静音要靠 areverse 翻转后再裁，否则只裁了开头。"""
        captured = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            Path(cmd[-1]).write_bytes(b"\xff\xfb" + b"\x00" * 600)
            return MagicMock(returncode=0, stderr=b"")

        with patch.object(pipeline.shutil, "which", return_value="/usr/bin/ffmpeg"):
            with patch.object(pipeline.subprocess, "run", side_effect=fake_run):
                pipeline.trim_silence(self.path)

        joined = " ".join(captured["cmd"])
        self.assertIn("silenceremove", joined)
        self.assertEqual(joined.count("areverse"), 2, "首尾都要处理：裁头 + 翻转裁尾 + 翻回")
        self.assertIn("-50dB", joined)
        self.assertIn("libmp3lame", joined, "裁完要重新编码成 mp3")

    def test_output_bitrate_preserved(self):
        captured = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            Path(cmd[-1]).write_bytes(b"\xff\xfb" + b"\x00" * 600)
            return MagicMock(returncode=0, stderr=b"")

        with patch.object(pipeline.shutil, "which", return_value="/usr/bin/ffmpeg"):
            with patch.object(pipeline.subprocess, "run", side_effect=fake_run):
                pipeline.trim_silence(self.path)

        cmd = captured["cmd"]
        self.assertIn("-b:a", cmd, "需要显式指定码率，避免 ffmpeg 默认码率把音质压坏")
        idx = cmd.index("-b:a")
        self.assertTrue(cmd[idx + 1].endswith("k"), f"码率格式应为 48k，实际 {cmd[idx + 1]}")


class LosslessTrimTests(unittest.TestCase):
    """首选无损方案：按 mp3 帧切分（-c copy），不重编码，音质一个比特都不动。"""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.path = Path(self.tmpdir.name) / "clip.mp3"
        self.path.write_bytes(b"\xff\xfb" + b"\x00" * 2000)
        patcher = patch.object(pipeline, "probe_duration", return_value=12.0)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_uses_stream_copy_when_ffprobe_available(self):
        captured = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            Path(cmd[-1]).write_bytes(b"\xff\xfb" + b"\x00" * 1200)
            return MagicMock(returncode=0, stderr=b"")

        with patch.object(pipeline.shutil, "which", return_value="/usr/bin/ffmpeg"):
            with patch.object(pipeline.subprocess, "run", side_effect=fake_run):
                ok = pipeline.trim_silence(self.path)

        self.assertTrue(ok)
        cmd = captured["cmd"]
        joined = " ".join(cmd)
        self.assertIn("-c copy", joined, "无损方案应使用流复制，不能重新编码")
        self.assertNotIn("libmp3lame", joined, "走流复制时不应出现编码器")
        self.assertIn("-ss", cmd, "需要偏移切掉头部静音")
        self.assertIn("-t", cmd, "需要指定保留时长以切掉尾部静音")

    def test_falls_back_to_reencode_when_duration_unknown(self):
        captured = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            Path(cmd[-1]).write_bytes(b"\xff\xfb" + b"\x00" * 600)
            return MagicMock(returncode=0, stderr=b"")

        with patch.object(pipeline, "probe_duration", return_value=None):
            with patch.object(pipeline.shutil, "which", return_value="/usr/bin/ffmpeg"):
                with patch.object(pipeline.subprocess, "run", side_effect=fake_run):
                    ok = pipeline.trim_silence(self.path)

        self.assertTrue(ok)
        self.assertIn("libmp3lame", " ".join(captured["cmd"]), "拿不到时长时回退到重编码方案")

    def test_cut_point_never_truncates_speech(self):
        """实测尾静音最早从结尾前 880ms 开始；切点必须落在语音结束之后，
        否则会把最后一个词切掉。同时头部切点不能越过实测头静音长度（190ms）。"""
        captured = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            Path(cmd[-1]).write_bytes(b"\xff\xfb" + b"\x00" * 1200)
            return MagicMock(returncode=0, stderr=b"")

        with patch.object(pipeline.shutil, "which", return_value="/usr/bin/ffmpeg"):
            with patch.object(pipeline.subprocess, "run", side_effect=fake_run):
                pipeline.trim_silence(self.path)

        cmd = captured["cmd"]
        ss = float(cmd[cmd.index("-ss") + 1])
        keep = float(cmd[cmd.index("-t") + 1])
        cut_end = ss + keep
        duration = 12.0

        self.assertLess(ss, 0.19, f"头部切点 {ss}s 越过了实测头静音 190ms，会切到语音开头")
        speech_end = duration - 0.88  # 尾静音最早可能从这里开始
        self.assertGreaterEqual(
            cut_end,
            speech_end - 0.001,
            f"尾部切点 {cut_end:.2f}s 早于语音结束点 {speech_end:.2f}s，会把最后一个词切掉",
        )
        self.assertLess(cut_end, duration, "切点不能超过音频总长")


if __name__ == "__main__":
    unittest.main(verbosity=2)
