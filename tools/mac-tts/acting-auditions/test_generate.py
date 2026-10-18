"""Lease failure tests do not load models or contact the production service."""

import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

import generate


class LeaseTests(unittest.TestCase):
    def test_busy_lease_never_stops_worker_or_spawns_renderer(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            credential = Path(directory) / "auth.json"
            credential.write_text(json.dumps({"endpoint": "http://localhost", "token": "test"}))
            argv = ["generate.py", "--model", "breeze-chapter", "--output", directory,
                    "--python", "/unused/python", "--credential", str(credential)]
            with patch("sys.argv", argv), patch("generate.subprocess.Popen") as spawn:
                with patch("generate.urllib.request.urlopen", side_effect=urllib.error.HTTPError(
                    "http://localhost/v1/lease", 409, "Busy", {}, None,
                )) as request:
                    with self.assertRaises(urllib.error.HTTPError):
                        generate.main()
                    self.assertEqual(request.call_count, 1)
                    self.assertEqual(request.call_args.args[0].full_url, "http://localhost/v1/lease")
                    spawn.assert_not_called()

    def test_active_status_releases_lease_without_stopping_worker(self) -> None:
        calls: list[str] = []

        def response(request: urllib.request.Request, timeout: int) -> io.BytesIO:
            calls.append(request.full_url)
            value = {"active": "production-job", "queued": 0} if request.full_url.endswith("status") else {}
            return io.BytesIO(json.dumps(value).encode())

        with tempfile.TemporaryDirectory() as directory:
            credential = Path(directory) / "auth.json"
            credential.write_text(json.dumps({"endpoint": "http://localhost", "token": "test"}))
            argv = ["generate.py", "--model", "breeze-chapter", "--output", directory,
                    "--python", "/unused/python", "--credential", str(credential)]
            with patch("sys.argv", argv), patch("generate.subprocess.Popen") as spawn:
                with patch("generate.urllib.request.urlopen", side_effect=response):
                    with self.assertRaisesRegex(RuntimeError, "Production work is active"):
                        generate.main()
                spawn.assert_not_called()
            self.assertEqual(calls, ["http://localhost/v1/lease", "http://localhost/v1/status",
                                     "http://localhost/v1/lease/release"])


if __name__ == "__main__":
    unittest.main()
