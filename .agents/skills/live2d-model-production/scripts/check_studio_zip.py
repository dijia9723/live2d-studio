import argparse
import json
import posixpath
import stat
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZIP_STORED, BadZipFile, ZipFile


MIB = 1024 * 1024


def relative_path(value):
    if (
        not isinstance(value, str)
        or not value
        or value.startswith('/')
        or any(char in value for char in ('\\', ':', '\x00'))
    ):
        raise ValueError(f'Expected a relative path with forward slashes: {value!r}')
    return value


def check_references(archive, manifest, files):
    if files[manifest].file_size > 2 * MIB:
        raise ValueError('The model manifest exceeds the Studio action reader limit (2 MiB).')
    model = json.loads(archive.read(manifest).decode('utf-8'))
    refs = model.get('FileReferences') if isinstance(model, dict) else None
    if not isinstance(refs, dict):
        raise ValueError('Expected a FileReferences object.')

    def require_file(reference, suffixes):
        reference = relative_path(reference)
        target = posixpath.normpath(posixpath.join(posixpath.dirname(manifest), reference))
        if target == '..' or target.startswith('../'):
            raise ValueError(f'Reference leaves the archive: {reference!r}')
        if not target.lower().endswith(suffixes):
            raise ValueError(f'Unexpected file type for model resource: {reference!r}')
        if target not in files or files[target].file_size == 0:
            raise ValueError(f'Missing or empty model resource: {target!r} (paths are case-sensitive)')

    if 'Moc' not in refs:
        raise ValueError('Missing FileReferences.Moc.')
    require_file(refs['Moc'], '.moc3')
    textures = refs.get('Textures')
    if not isinstance(textures, list) or not textures:
        raise ValueError('Expected a non-empty FileReferences.Textures list.')
    for texture in textures:
        require_file(texture, ('.png', '.jpg', '.jpeg'))

    for key in ('Physics', 'Pose', 'DisplayInfo'):
        if key in refs:
            require_file(refs[key], '.json')

    def check_items(items, label, suffix):
        if not isinstance(items, list):
            raise ValueError(f'Expected an array for {label}.')
        for item in items:
            if not isinstance(item, dict) or 'File' not in item:
                raise ValueError(f'Missing File in {label}.')
            require_file(item['File'], suffix)
            if suffix == '.motion3.json' and 'Sound' in item:
                require_file(item['Sound'], ('.mp3', '.wav'))

    motions = refs.get('Motions', {})
    if not isinstance(motions, dict):
        raise ValueError('Expected an object for FileReferences.Motions.')
    for group, items in motions.items():
        check_items(items, f'Motions[{group!r}]', '.motion3.json')
    check_items(refs.get('Expressions', []), 'Expressions', '.exp3.json')


def check_zip(path):
    with ZipFile(path) as archive:
        entries = archive.infolist()
        paths = set()
        files = {}
        for entry in entries:
            name = relative_path(entry.orig_filename).removesuffix('/')
            if any(part in ('', '.', '..') for part in name.split('/')):
                raise ValueError(f'Non-canonical ZIP path: {entry.orig_filename!r}')
            if name.casefold() in paths:
                raise ValueError(f'Duplicate or case-colliding ZIP path: {name!r}')
            paths.add(name.casefold())
            if stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError(f'ZIP contains a symbolic link: {name!r}')
            if entry.compress_type not in (ZIP_STORED, ZIP_DEFLATED) or entry.flag_bits & 1:
                raise ValueError(f'Use unencrypted ZIP with Store or Deflate: {name!r}')
            if not entry.is_dir():
                files[name] = entry

        manifests = [name for name in files if name.endswith('.model3.json')]
        if len(manifests) != 1:
            raise ValueError(f'Expected exactly one .model3.json; found {len(manifests)}.')
        manifest = manifests[0]
        check_references(archive, manifest, files)
        corrupt = archive.testzip()
        if corrupt is not None:
            raise ValueError(f'ZIP integrity check failed: {corrupt!r}')
        return manifest


def main():
    parser = argparse.ArgumentParser(description='Preflight a Live2D Studio runtime ZIP.')
    parser.add_argument('zip_path', type=Path)
    args = parser.parse_args()
    try:
        manifest = check_zip(args.zip_path)
    except (OSError, ValueError, BadZipFile, RuntimeError) as error:
        print(f'FAIL: {error}', file=sys.stderr)
        return 1
    print(f'PASS: {manifest} (ZIP preflight only; stage playback not tested)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
