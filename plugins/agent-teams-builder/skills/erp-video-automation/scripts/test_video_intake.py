"""Independent offline intake tests. Fake files are tested only in --no-frames mode."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import video_intake as v


class IntakeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source = self.root / "inventory-fixture.bin"
        self.source.write_bytes(b"Not a video: test metadata-only inventory.\n")
        self.library = self.root / "library"

    def tearDown(self):
        self.tmp.cleanup()

    def args(self, *extra):
        return v.parser().parse_args(["extract", "--source", str(self.source), "--library", str(self.library),
                                     "--id", "receipt-create", "--title", "收據輸入", "--tag", "Key收據", "--no-frames", *extra])

    def test_inventory_explicitly_unprobed_and_no_runnable_files(self):
        with patch.object(v, "backend_for", side_effect=AssertionError("must not load decoder")):
            result = v.intake(self.args())
        self.assertEqual(result["status"], "created")
        self.assertFalse(result["automation_generated"])
        folder = Path(result["folder"])
        self.assertEqual({p.name for p in folder.iterdir()}, {"source.json", "workflow.md"})
        source = json.loads((folder / "source.json").read_text(encoding="utf-8"))
        self.assertEqual(source["video_metadata"]["probe_status"], "not_probed")
        self.assertEqual(source["sha256"], v.file_hash(self.source))
        self.assertEqual(source["candidate_tags"], ["Key收據"])
        self.assertEqual(source["frames"], [])
        self.assertIn("不可先開啟、點擊、填寫或查詢 ERP", (folder / "workflow.md").read_text(encoding="utf-8"))

    def test_duplicate_content_new_id_returns_original_folder(self):
        first = v.intake(self.args())
        second_source = self.root / "same-content-other-name.bin"
        second_source.write_bytes(self.source.read_bytes())
        second = v.intake(self.args("--source", str(second_source), "--id", "another-id"))
        self.assertEqual(second["status"], "duplicate")
        self.assertEqual(second["existing_folder"], first["folder"])
        self.assertFalse((self.library / "another-id").exists())

    def test_existing_target_never_overwritten(self):
        dest = self.library / "receipt-create"
        dest.mkdir(parents=True)
        sentinel = dest / "sentinel.txt"
        sentinel.write_text("keep")
        with self.assertRaises(v.IntakeError):
            v.intake(self.args())
        self.assertEqual(sentinel.read_text(), "keep")

    def test_invalid_ids_rejected_before_library_created(self):
        for value in ("../escape", "a/b", "a\\b", "x", "CON", "con", "nul", "com1", "lpt9", "收據", "a" * 81):
            with self.subTest(value=value), self.assertRaises(v.IntakeError):
                v.intake(self.args("--id", value))
        self.assertFalse(self.library.exists())

    def test_invalid_ranges_and_bounds(self):
        for extra in (("--start", "-1"), ("--start", "nan"), ("--interval", "0"), ("--interval", "inf"),
                      ("--end", "0"), ("--end", "nan"), ("--start", "5", "--end", "4"),
                      ("--max-frames", "0"), ("--max-frames", "241")):
            with self.subTest(extra=extra), self.assertRaises(v.IntakeError):
                v.intake(self.args(*extra))
        self.assertFalse(self.library.exists())

    def test_missing_or_empty_file_rejected(self):
        with self.assertRaises(v.IntakeError):
            v.intake(self.args("--source", str(self.root / "missing.mp4")))
        self.source.write_bytes(b"")
        with self.assertRaises(v.IntakeError):
            v.intake(self.args())

    def test_blank_title_and_tags(self):
        for extra in (("--title", "  "), ("--tag", " ")):
            with self.subTest(extra=extra), self.assertRaises(v.IntakeError):
                v.intake(self.args(*extra))

    def test_failures_clean_only_owned_staging(self):
        self.library.mkdir()
        keep = self.library / "keep.txt"
        keep.write_text("keep")
        with patch.object(v, "workflow_draft", side_effect=OSError("simulated")):
            with self.assertRaises(OSError):
                v.intake(self.args())
        self.assertEqual([p.name for p in self.library.iterdir()], ["keep.txt"])
        self.assertEqual(keep.read_text(), "keep")

    def test_changed_source_rejected(self):
        with patch.object(v, "file_hash", side_effect=["initial", "changed"]):
            with self.assertRaises(v.IntakeError):
                v.intake(self.args())
        self.assertFalse((self.library / "receipt-create").exists())
        self.assertEqual(list(self.library.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
