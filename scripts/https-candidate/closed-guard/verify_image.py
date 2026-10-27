#!/usr/bin/env python3
"""Offline Docker-save consistency check. No Docker calls or compiled-code evaluation."""
import argparse
import hashlib
import json
import os
import signal
import stat
import tarfile
from pathlib import Path, PurePosixPath
from policy import (Blocked, require, DIGEST, private_directory, no_symlink_path,
                    verify_context, sha, exclusive_write, encode)

TOOLS = Path(__file__).resolve().parent
TARGETS = {'candidate-inputs.json':8*1024*1024,
           'candidate-launch.mjs':65536,'app/.output/server/index.mjs':8*1024*1024}
MAX_ARCHIVE = 2*1024*1024*1024

def member_name(name):
    while name.startswith('./'):
        name = name[2:]
    p = PurePosixPath(name)
    require(not p.is_absolute() and '..' not in p.parts, 'unsafe_archive_path')
    return p.as_posix().rstrip('/')

def bounded_member(archive, name, limit):
    member = archive.getmember(name)
    require(member.isfile() and not member.sparse and member.size <= limit, 'unsupported_archive_member')
    stream = archive.extractfile(member)
    require(stream is not None, 'missing_archive_member')
    data = stream.read(limit+1)
    require(len(data) <= limit, 'archive_member_limit')
    return data

def verify(archive_path, expected_id, context):
    manifest, source_bytes = verify_context(context,TOOLS)
    path = no_symlink_path(archive_path)
    fd = os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid==os.getuid()
                and info.st_mode&0o077==0 and info.st_size <= MAX_ARCHIVE, 'private_bounded_archive_required')
        archive_hash = hashlib.sha256()
        while chunk := stream.read(1024*1024):
            archive_hash.update(chunk)
        stream.seek(0)
        with tarfile.open(fileobj=stream,mode='r:') as outer:
            entries = outer.getmembers()
            require(len(entries) <= 1000, 'outer_archive_count')
            require(len({m.name for m in entries}) == len(entries), 'duplicate_archive_member')
            for member in entries:
                member_name(member.name)
            saved = json.loads(bounded_member(outer,'manifest.json',65536))
            require(isinstance(saved,list) and len(saved)==1, 'single_image_export_required')
            config_raw = bounded_member(outer,saved[0]['Config'],1024*1024)
            require('sha256:'+sha(config_raw)==expected_id, 'image_identity_mismatch')
            config = json.loads(config_raw)
            runtime = config['config']
            require(not runtime.get('Volumes') and not config.get('config',{}).get('OnBuild'), 'unexpected_image_hooks_or_volumes')
            require(config['os']+'/'+config['architecture']==manifest['base']['platform'], 'platform_mismatch')
            require(runtime.get('Entrypoint')==['node','/candidate-launch.mjs']
                    and runtime.get('Cmd') in (None,[]) and runtime.get('WorkingDir')=='/app'
                    and runtime.get('User')=='0:0', 'runtime_metadata_mismatch')
            labels = runtime.get('Labels') or {}
            require(labels.get('devcaught.closed-build.input-sha256')==sha(source_bytes), 'input_label_mismatch')
            require(labels.get('org.opencontainers.image.base.name')==
                    'docker.io/library/node@'+manifest['base']['nodeDigest'], 'base_label_mismatch')
            environment = runtime.get('Env') or []
            required_env = {'NODE_ENV=production','HOST=0.0.0.0','PORT=3000',
                            'DEVCAUGHT_DB_PATH=/app/data/devcaught.db','DEVCAUGHT_REQUIRE_PERSISTENT_DB=1'}
            require(required_env.issubset(set(environment)), 'runtime_environment_mismatch')
            # Only immutable official-base defaults and declared normal runtime settings.
            allowed_names = {'PATH','NODE_VERSION','YARN_VERSION','NODE_ENV','HOST','PORT',
                'DEVCAUGHT_HOST','DEVCAUGHT_SMTP_PORT','DEVCAUGHT_HTTP_PORT','DEVCAUGHT_DB_PATH','DEVCAUGHT_REQUIRE_PERSISTENT_DB'}
            require(all(e.split('=',1)[0] in allowed_names for e in environment), 'unexpected_image_environment')
            require('NODE_VERSION='+manifest['base']['nodeVersion'] in environment,'node_version_mismatch')
            layers = saved[0]['Layers']
            diff_ids = config['rootfs']['diff_ids']
            require(1 <= len(layers) <= 64 and len(layers)==len(diff_ids),'layer_count')
            require(diff_ids[:len(manifest['base']['baseDiffIds'])]==manifest['base']['baseDiffIds'], 'base_layers_mismatch')
            files = {}
            total_members = 0
            for layer_name,diff_id in zip(layers,diff_ids):
                member_name(layer_name)
                member = outer.getmember(layer_name)
                require(member.isfile() and not member.sparse and member.size<=MAX_ARCHIVE, 'unsupported_layer')
                layer_stream = outer.extractfile(member)
                require(layer_stream is not None,'missing_layer')
                digest = hashlib.sha256()
                while chunk := layer_stream.read(1024*1024):
                    digest.update(chunk)
                require('sha256:'+digest.hexdigest()==diff_id,'layer_digest_mismatch')
                layer_stream.seek(0)
                updates, removals = {}, []
                # Classic uncompressed Docker-save layers only. No extraction to disk.
                with tarfile.open(fileobj=layer_stream,mode='r|') as layer:
                    for item in layer:
                        total_members += 1
                        require(total_members<=200000,'layer_member_limit')
                        name = member_name(item.name)
                        parent = str(PurePosixPath(name).parent)
                        parent = '' if parent=='.' else parent
                        leaf = PurePosixPath(name).name
                        if leaf=='.wh..wh..opq':
                            removals.append(parent)
                            continue
                        if leaf.startswith('.wh.'):
                            removals.append((parent+'/' if parent else '')+leaf[4:])
                            continue
                        relevant = any(target==name or target.startswith(name+'/') for target in TARGETS)
                        if relevant:
                            require(item.isfile() or item.isdir(),'special_target_path')
                            require(not item.sparse,'sparse_target')
                        if name in TARGETS:
                            require(item.isfile() and item.size<=TARGETS[name] and name not in updates,'invalid_target')
                            content = layer.extractfile(item)
                            updates[name] = content.read(TARGETS[name]+1)
                            require(len(updates[name])<=TARGETS[name],'target_limit')
                # Whiteouts affect lower layers, independently of tar member order.
                for removed in removals:
                    for name in list(files):
                        if removed=='' or name==removed or name.startswith(removed+'/'):
                            del files[name]
                files.update(updates)
            require(set(files)==set(TARGETS),'required_runtime_file_missing')
            require(files['candidate-inputs.json']==source_bytes,'embedded_input_manifest_mismatch')
            require(sha(files['candidate-launch.mjs'])==manifest['launcherSha256'],'embedded_launcher_mismatch')
            require(len(files['app/.output/server/index.mjs'])>0,'empty_server_entry')
        after = os.fstat(stream.fileno())
        require((info.st_size,info.st_mtime_ns,info.st_ctime_ns)==
                (after.st_size,after.st_mtime_ns,after.st_ctime_ns),'archive_changed')
    return {'schemaVersion':1,'result':'LOCAL_CONSISTENCY_VERIFIED','imageId':expected_id,
        'archiveSha256':archive_hash.hexdigest(),'inputManifestSha256':sha(source_bytes),
        'launcherSha256':manifest['launcherSha256'],'baseDigest':manifest['base']['nodeDigest'],
        'platform':manifest['base']['platform'],'sourceGuard':'literal_false',
        'compiledGuard':'NOT_VERIFIED','runtimeClosure':'NOT_TESTED',
        'buildExecutionAttestation':'OPERATOR_REVIEW_REQUIRED'}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--context',required=True,type=Path)
    parser.add_argument('--archive',required=True,type=Path)
    parser.add_argument('--image-id',required=True)
    parser.add_argument('--report',required=True,type=Path)
    args=parser.parse_args()
    require(bool(DIGEST.fullmatch(args.image_id)),'immutable_image_id_required')
    require(all(p.is_absolute() for p in [args.context,args.archive,args.report]),'absolute_paths_required')
    private_directory(args.report.parent)
    require(not os.path.lexists(args.report),'report_exists')
    signal.signal(signal.SIGALRM,lambda *_: (_ for _ in ()).throw(Blocked('verification_timeout')))
    signal.alarm(120)
    result=verify(args.archive,args.image_id,args.context)
    exclusive_write(args.report,encode(result))
    print(json.dumps(result))

if __name__=='__main__':
    try:
        main()
    except Exception as error:
        category=str(error) if isinstance(error,Blocked) else 'offline_verification_unavailable'
        print(json.dumps({'result':'NOT_VERIFIED','category':category,'compiledGuard':'NOT_VERIFIED'}))
        raise SystemExit(1)
