#!/usr/bin/env python3
"""Prepare a new sanitized context only. No Docker, dependency install or build."""
import argparse
import json
import os
import re
from pathlib import Path
from policy import (Blocked, require, private_directory, read_regular, approval_valid,
                    snapshot_inputs, sha, exclusive_write, encode, sync_dir, verify_context)

TOOLS = Path(__file__).resolve().parent
REPOSITORY = TOOLS.parents[2]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node-approval', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    require(args.node_approval.is_absolute() and args.output.is_absolute(), 'absolute_paths_required')
    approval = json.loads(read_regular(args.node_approval, 16384, private=True))
    approval_valid(approval)
    parent = private_directory(args.output.parent)
    output = parent / args.output.name
    require(not output.is_relative_to(REPOSITORY) and not output.is_relative_to(Path('/tmp'))
            and not output.is_relative_to(Path('/var/tmp')), 'durable_external_output_required')
    require(not os.path.lexists(output), 'output_exists')
    files = snapshot_inputs(REPOSITORY)
    guard = read_regular(REPOSITORY/'src/lib/inbox/private-inbox-release.ts').decode()
    guard = re.sub(r'/\*.*?\*/|//[^\n]*', '', guard, flags=re.S).strip()
    require(bool(re.fullmatch(r'export\s+const\s+PRIVATE_INBOX_POSTGRES_VERIFIED\s*=\s*false\s*;', guard)), 'source_guard_not_literal_false')
    package = json.loads(read_regular(REPOSITORY/'package.json'))
    require(package.get('workspaces') == ['apps/*','packages/*'], 'workspace_contract_changed')
    lock = json.loads(read_regular(REPOSITORY/'package-lock.json'))
    require(lock.get('lockfileVersion') in (2,3) and isinstance(lock.get('packages'),dict), 'unsupported_lockfile')
    for item in lock['packages'].values():
        resolved = item.get('resolved')
        if resolved:
            require((item.get('link') is True and resolved in ('apps/server','packages/shared','packages/parsers'))
                    or (resolved.startswith('https://registry.npmjs.org/') and isinstance(item.get('integrity'),str)), 'unapproved_dependency_source')
    recipe = read_regular(TOOLS/'Dockerfile')
    manifest = {'schemaVersion':1,'purpose':'normal_closed_guard','base':approval,
        'files':files,'dockerfileSha256':sha(recipe),
        'launcherSha256':files['scripts/candidate/launch.mjs']['sha256'],
        'sourceGuard':'literal_false','compiledGuard':'NOT_VERIFIED',
        'compilation':'normal_vite_no_migration_no_authorization_transform'}
    output.mkdir(mode=0o700)
    sync_dir(parent)
    inputs = output/'inputs'
    inputs.mkdir(mode=0o700)
    # A second read checks the selected bytes did not change since snapshotting.
    for relative, expected in files.items():
        data = read_regular(REPOSITORY/relative)
        require(sha(data) == expected['sha256'] and len(data) == expected['size'], 'source_changed')
        target = inputs/relative
        target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        exclusive_write(target,data)
    # Retain empty allowed roots for predictable revalidation and Vite globbing.
    from policy import TREES
    for relative in TREES:
        (inputs/relative).mkdir(mode=0o700,parents=True,exist_ok=True)
    for directory, _, _ in os.walk(inputs,topdown=False):
        sync_dir(directory)
    exclusive_write(output/'Dockerfile',recipe)
    exclusive_write(output/'provenance.json',encode(manifest))
    sync_dir(output)
    verify_context(output,TOOLS)
    print(json.dumps({'result':'PREPARED','context':str(output),
        'inputManifestSha256':sha(encode(manifest)),'files':len(files),
        'compiledGuard':'NOT_VERIFIED','buildExecuted':False}))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        category = str(error) if isinstance(error,Blocked) else 'preparation_unavailable'
        print(json.dumps({'result':'BLOCKED','category':category,'buildExecuted':False}))
        raise SystemExit(1)
