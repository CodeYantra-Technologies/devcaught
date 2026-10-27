"""Shared offline policy. Importing this module performs no filesystem I/O."""
import hashlib
import json
import os
import re
import stat
from pathlib import Path, PurePosixPath

FILES = (
    'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
    'apps/server/package.json', 'packages/shared/package.json',
    'packages/parsers/package.json', 'scripts/app-env-plugin.mjs',
    'scripts/migration-plan.mjs', 'scripts/candidate/launch.mjs',
)
TREES = ('src', 'apps/server/src', 'packages/shared/src', 'packages/parsers/src',
         'public', 'migrations')
SKIP_PARTS = frozenset(('.devcaught', '.git', '.aws', '.ssh', '.codex', '.agents',
    '.npmrc', '.yarnrc', '.yarnrc.yml', 'node_modules', '.output', '.vercel',
    'dist', 'build', 'coverage', '.cache', '.vite', 'data', 'logs', 'uploads',
    'secrets', 'credentials', 'fixtures', '__fixtures__', 'testdata', 'tests',
    '__tests__', 'private-api-acceptance', 'candidate-auth'))
CODE_SUFFIXES = frozenset(('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss', '.svg'))
PUBLIC_SUFFIXES = CODE_SUFFIXES | frozenset(('.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2'))
DIGEST = re.compile(r'sha256:[0-9a-f]{64}\Z')
MAX_FILE = 8 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024
MAX_FILES = 10000

class Blocked(Exception):
    """Only fixed, non-sensitive reason categories belong in this exception."""

def require(condition, category):
    if not condition:
        raise Blocked(category)

def excluded(relative):
    # Called on names BEFORE lstat/open/hash/copy. Never descend into exclusions.
    p = PurePosixPath(relative)
    parts = p.parts
    return (p.is_absolute() or not parts or any(x in ('..', '.') for x in parts)
        or any(x in SKIP_PARTS or x.startswith('.env') for x in parts)
        or p.name == 'preview.ts'
        or p.name in ('Dockerfile.auth', 'prepare-auth-build.mjs', 'auth-policy.ts',
                      'run-auth.sh', 'verify-auth.ts', 'AUTHORIZATION.md')
        or bool(re.search(r'(^|[._-])(secret|credential|password)s?([._-]|$)', p.name, re.I))
        or bool(re.search(r'\.(test|spec)\.', p.name))
        or bool(re.search(r'\.(db(?:-wal|-shm)?|sqlite(?:3|-wal|-shm)?|sqlitedb|pem|key|p12|pfx|crt|log|map|tsbuildinfo)$', p.name, re.I)))

def allowed_file(relative):
    if excluded(relative):
        return False
    if relative in FILES:
        return True
    p = PurePosixPath(relative)
    if relative.startswith('migrations/'):
        return len(p.parts) == 2 and bool(re.fullmatch(r'\d{4}_[A-Za-z0-9_-]+\.sql', p.name))
    if relative.startswith('public/'):
        return p.suffix.lower() in PUBLIC_SUFFIXES or relative == 'public/robots.txt'
    return any(relative.startswith(root + '/') for root in TREES[:4]) and p.suffix.lower() in CODE_SUFFIXES

def sha(data):
    return hashlib.sha256(data).hexdigest()

def no_symlink_path(path):
    path = Path(os.path.abspath(path))
    for part in [*reversed(path.parents), path]:
        info = part.lstat()
        require(not stat.S_ISLNK(info.st_mode), 'symlink_rejected')
    return path

def private_directory(path):
    path = no_symlink_path(path)
    info = path.stat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and info.st_mode & 0o077 == 0, 'private_directory_required')
    return path

def read_regular(path, limit=MAX_FILE, private=False):
    # Resolve each ancestor through directory descriptors: a concurrent symlink
    # substitution cannot redirect the subsequent open outside that directory.
    path = Path(os.path.abspath(path))
    parent = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.parts[1:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= limit,
                'unsafe_or_oversized_file')
        if private:
            require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0, 'private_file_required')
        data = bytearray()
        while len(data) <= limit:
            chunk = os.read(fd, min(65536, limit + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        require(len(data) <= limit, 'file_limit')
        after = os.fstat(fd)
        require((info.st_size, info.st_mtime_ns, info.st_ctime_ns) ==
                (after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'input_changed')
        return bytes(data)
    finally:
        os.close(fd)

def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def exclusive_write(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    sync_dir(Path(path).parent)

def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()

def approval_valid(approval):
    require(set(approval) == {'schemaVersion','nodeDigest','platform','nodeVersion','npmVersion',
                              'baseDiffIds','reviewedBy','reviewedAt','registrySource','approved'},
            'approval_schema')
    require(approval['schemaVersion'] == 1 and approval['approved'] is True, 'base_not_approved')
    require(DIGEST.fullmatch(approval['nodeDigest']) is not None, 'immutable_digest_required')
    require(approval['platform'] in ('linux/amd64','linux/arm64'), 'unsupported_platform')
    require(bool(re.fullmatch(r'22\.\d+\.\d+', approval['nodeVersion']))
            and tuple(map(int, approval['nodeVersion'].split('.'))) >= (22,13,0), 'node_version')
    require(bool(re.fullmatch(r'\d+\.\d+\.\d+', approval['npmVersion'])), 'npm_version')
    require(1 <= len(approval['baseDiffIds']) <= 32
            and all(isinstance(x,str) and DIGEST.fullmatch(x) for x in approval['baseDiffIds']), 'base_layers_required')
    require(isinstance(approval['reviewedBy'],str) and 1 <= len(approval['reviewedBy']) <= 100
            and bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', approval['reviewedAt'])), 'review_required')
    require(approval['registrySource'] == 'docker.io/library/node', 'official_base_required')

def walk_inputs(root):
    root = no_symlink_path(root)
    paths = []
    def visit(relative):
        if excluded(relative):
            return
        require(len(PurePosixPath(relative).parts) <= 32, 'directory_depth_limit')
        if relative.startswith('migrations/') and not allowed_file(relative):
            return  # Only root SQLite migration filenames are build inputs.
        path = root / relative
        no_symlink_path(path)
        info = path.lstat()
        require(not stat.S_ISLNK(info.st_mode), 'symlink_rejected')
        if stat.S_ISDIR(info.st_mode):
            # Names only; excluded entries are never stat'ed or opened.
            for name in sorted(os.listdir(path)):
                visit(relative + '/' + name)
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'non_regular_input')
            require(allowed_file(relative), 'unreviewed_input_type')
            paths.append(relative)
            require(len(paths) <= MAX_FILES, 'file_count_limit')
    for relative in FILES:
        visit(relative)
    for relative in TREES:
        visit(relative)
    return sorted(set(paths))

def snapshot_inputs(root):
    paths = walk_inputs(root)
    result = {}
    total = 0
    for relative in paths:
        data = read_regular(Path(root) / relative)
        total += len(data)
        require(total <= MAX_TOTAL, 'context_size_limit')
        result[relative] = {'sha256':sha(data), 'size':len(data)}
    return result

def verify_context(context, tool_dir):
    context = private_directory(context)
    require(set(os.listdir(context)) == {'Dockerfile','inputs','provenance.json'}, 'unexpected_context_entry')
    raw = read_regular(context/'provenance.json', private=True)
    manifest = json.loads(raw)
    require(manifest['schemaVersion'] == 1 and manifest['purpose'] == 'normal_closed_guard', 'context_manifest')
    approval_valid(manifest['base'])
    # Re-enumeration protects against omitted/added allowlisted files. Forbidden
    # names in a prepared context are rejected by name, without reading contents.
    def reject_exclusions(path, relative=''):
        require(len(PurePosixPath(relative).parts) <= 32, 'directory_depth_limit')
        for name in os.listdir(path):
            rel = (relative+'/' if relative else '')+name
            require(not excluded(rel), 'excluded_context_entry')
            candidate = no_symlink_path(path/name)
            if candidate.is_dir():
                require(any(rel == tree or rel.startswith(tree+'/') or tree.startswith(rel+'/') for tree in TREES)
                        or any(file.startswith(rel+'/') for file in FILES), 'unexpected_context_directory')
                reject_exclusions(candidate,rel)
            else:
                require(allowed_file(rel), 'unexpected_context_file')
    reject_exclusions(context/'inputs')
    require(snapshot_inputs(context/'inputs') == manifest['files'], 'context_digest_mismatch')
    recipe = read_regular(context/'Dockerfile', private=True)
    require(recipe == read_regular(tool_dir/'Dockerfile') and sha(recipe) == manifest['dockerfileSha256'], 'recipe_mismatch')
    require(manifest['files']['scripts/candidate/launch.mjs']['sha256'] == manifest['launcherSha256'], 'launcher_manifest')
    guard = read_regular(context/'inputs/src/lib/inbox/private-inbox-release.ts').decode()
    guard = re.sub(r'/\*.*?\*/|//[^\n]*', '', guard, flags=re.S).strip()
    require(bool(re.fullmatch(r'export\s+const\s+PRIVATE_INBOX_POSTGRES_VERIFIED\s*=\s*false\s*;', guard))
            and manifest['sourceGuard'] == 'literal_false'
            and manifest['compiledGuard'] == 'NOT_VERIFIED', 'source_guard_not_literal_false')
    return manifest, raw
