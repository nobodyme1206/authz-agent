import hashlib, json, os, shutil, uuid
from pathlib import Path
from fastapi import HTTPException

EXCLUDED = {'.git', '.svn', 'node_modules', 'target', 'dist', '.next', '__pycache__', '.venv', '.DS_Store'}
MAX_FILE = 8 * 1024 * 1024
MAX_TOTAL = 1024 * 1024 * 1024

def safe_path(root: Path, relative: str, directory=False):
    if not relative or Path(relative).is_absolute() or '\\' in relative or any(x in ('..', '') for x in relative.split('/')):
        raise HTTPException(422, 'invalid_relative_path')
    root = root.resolve()
    p = root
    for part in Path(relative).parts:
        p = p / part
        if p.is_symlink(): raise HTTPException(422, 'symlinks_not_allowed')
    p = p.resolve()
    if not p.is_relative_to(root) or not p.exists(): raise HTTPException(404, 'file_not_found')
    if directory and not p.is_dir(): raise HTTPException(422, 'not_a_directory')
    if not directory and not p.is_file(): raise HTTPException(422, 'not_a_file')
    return p

def read_evidence(root, relative, start, end, cache=None):
    if start < 1 or end < start or end - start >= 300: raise HTTPException(422, 'invalid_line_range')
    p = safe_path(root, relative)
    if p.stat().st_size > MAX_FILE: raise HTTPException(422, 'file_too_large')
    try:
        if cache is not None and p in cache: lines = cache[p]
        else:
            lines = p.read_text(encoding='utf-8').splitlines()
            if cache is not None: cache[p] = lines
    except UnicodeError: raise HTTPException(422, 'not_utf8_text')
    if end > len(lines): raise HTTPException(422, 'line_out_of_range')
    content = '\n'.join(lines[start-1:end])
    if len(content.encode()) > 65536: raise HTTPException(422, 'evidence_too_large')
    return {'file': relative, 'start_line': start, 'end_line': end, 'content': content, 'total_lines': len(lines)}

def snapshot_tree(source, storage):
    sid = 'snap-' + uuid.uuid4().hex
    storage.mkdir(parents=True, exist_ok=True)
    tmp = storage / ('.building-' + sid)
    tmp.mkdir()
    manifest, size = [], 0
    try:
        for directory, dirs, files in os.walk(source, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in EXCLUDED)
            for d in dirs:
                if (Path(directory) / d).is_symlink(): raise HTTPException(422, 'source_contains_symlink')
            for name in sorted(files):
                if name in EXCLUDED: continue
                src = Path(directory) / name
                if src.is_symlink() or not src.is_file(): raise HTTPException(422, 'source_contains_special_file')
                rel = src.relative_to(source).as_posix()
                dst = tmp / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                before = src.stat()
                h = hashlib.sha256()
                count = 0
                with src.open('rb') as f, dst.open('xb') as out:
                    while chunk := f.read(1024 * 1024):
                        count += len(chunk); size += len(chunk)
                        if size > MAX_TOTAL: raise HTTPException(422, 'snapshot_size_limit')
                        h.update(chunk); out.write(chunk)
                after = src.stat()
                if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
                    raise HTTPException(409, 'source_changed_during_snapshot')
                manifest.append({'file': rel, 'size': count, 'sha256': h.hexdigest()})
                if len(manifest) > 100000: raise HTTPException(422, 'snapshot_file_limit')
        manifest.sort(key=lambda x: x['file'])
        revision = 'sha256:' + hashlib.sha256(json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        final = storage / sid
        tmp.rename(final)
        return sid, revision, manifest, size
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
