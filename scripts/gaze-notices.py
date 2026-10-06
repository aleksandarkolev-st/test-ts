"""Retain installed wheel notices and Python's license with the frozen worker."""
import importlib.metadata
import json
from pathlib import Path
import shutil
import sys

root = Path(__file__).resolve().parents[1]
output = root / '.local/gaze-dist/gaze-worker/licenses'
output.mkdir(parents=True, exist_ok=True)
versions = {}
for package in importlib.metadata.distributions():
    name = package.metadata['Name']
    versions[name] = package.version
    for entry in package.files or []:
        if any(part.lower().startswith(('license', 'copying', 'notice', 'thirdpartynotice', 'third_party_notice')) for part in entry.parts):
            source = Path(package.locate_file(entry))
            if source.is_file():
                target = output / name / entry
                # Wheel entries can reference scripts outside site-packages;
                # do not let those paths escape the notice directory.
                if not target.resolve().is_relative_to(output.resolve()):
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
for name in ['LICENSE.txt', 'LICENSE']:
    source = Path(sys.base_prefix) / name
    if source.is_file():
        shutil.copyfile(source, output / 'PYTHON-LICENSE.txt')
        break
else:
    raise RuntimeError('Python distribution license is missing')
(output / 'versions.json').write_text(json.dumps(versions, indent=2), encoding='utf-8')
print(f'Collected installed wheel notices for {len(versions)} packages.')
