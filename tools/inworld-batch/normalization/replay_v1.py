"""Replay the hash-pinned historical formatter for immutable queued inputs."""
from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path
import runpy
import sys


def main() -> None:
    module_path = Path(__file__).with_name('speech_parts_v1.py')
    expected = '2d273c9d185975c3cfef49f8fd6e893e657f13893650560188d505dee9053b6a'
    if hashlib.sha256(module_path.read_bytes()).hexdigest() != expected:
        raise ValueError('Historical speech formatter changed')
    spec = importlib.util.spec_from_file_location('speech_parts', module_path)
    if spec is None or spec.loader is None:
        raise ValueError('Historical speech formatter unavailable')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sys.modules['speech_parts'] = module
    runpy.run_path(str(module_path.parent.parent / 'normalize.py'), run_name='__main__')


if __name__ == '__main__':
    main()
