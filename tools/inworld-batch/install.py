"""Install immutable publication objects from the private NAS archive."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import sys


def main() -> None:
    source, destination = (Path(value).resolve() for value in sys.argv[1:3])
    archive, fictions = (Path(value).resolve() for value in sys.argv[3:5])
    uid, gid = (int(value) for value in sys.argv[5:7])
    if not source.is_relative_to(archive) or destination.parent != fictions or source == archive:
        raise ValueError('Unexpected publication paths')
    for path in source.rglob('*'):
        if path.is_symlink():
            raise ValueError('Symlinks are not publication files')
        if not path.is_file():
            continue
        relative = path.relative_to(source)
        if relative.parts[0] not in ('plans', 'sources', 'analyses', 'assemblies', 'deliveries'):
            raise ValueError('Unexpected publication object')
        target = destination / relative
        if target.exists():
            equal = json.loads(target.read_text()) == json.loads(path.read_text()) if target.suffix == '.json' else target.read_bytes() == path.read_bytes()
            if not equal:
                raise ValueError('Existing immutable object differs: ' + str(relative))
            continue
        missing = []
        parent = target.parent
        while not parent.exists():
            missing.append(parent)
            parent = parent.parent
        for directory in reversed(missing):
            directory.mkdir(mode=0o700)
            os.chown(directory, uid, gid)
        temporary = target.with_suffix(target.suffix + '.install-tmp')
        shutil.copyfile(path, temporary)
        temporary.chmod(0o600)
        os.chown(temporary, uid, gid)
        temporary.replace(target)


if __name__ == '__main__':
    main()
