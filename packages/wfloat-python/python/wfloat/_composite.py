"""Validation shared by registry consumers of transport-split files."""
from collections.abc import Mapping
from pathlib import PurePosixPath
import re


def composite_parts(asset):
    """Return ordered transport records, or () for an ordinary asset."""
    if 'parts' not in asset:
        return ()
    parts = asset['parts']
    filename = asset.get('filename')
    if ('path' in asset or not isinstance(filename, str) or not filename
            or filename in ('.', '..') or '/' in filename or '\\' in filename
            or not isinstance(parts, (list, tuple)) or not parts):
        raise ValueError('Invalid composite registry asset')
    for record in (asset, *parts):
        if (not isinstance(record, Mapping)
                or not isinstance(record.get('sha256'), str)
                or not re.fullmatch(r'[0-9a-fA-F]{64}', record['sha256'])
                or type(record.get('sizeBytes')) is not int or record['sizeBytes'] < 0):
            raise ValueError('Composite assets require SHA-256 and sizeBytes for every record')
    paths = []
    for part in parts:
        path = part.get('path')
        if (not isinstance(path, str) or not path.startswith('/') or path.endswith('/')
                or '\\' in path or PurePosixPath(path).name in ('', '.', '..')
                or '..' in PurePosixPath(path).parts or 'parts' in part):
            raise ValueError('Invalid composite part path')
        paths.append(path)
    if len(set(paths)) != len(paths) or sum(p['sizeBytes'] for p in parts) != asset['sizeBytes']:
        raise ValueError('Composite parts must be unique and sum to the whole sizeBytes')
    return tuple(parts)
