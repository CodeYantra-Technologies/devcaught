#!/usr/bin/env python3
"""Explicitly approved disposable closure check; never a compiled-guard proof."""
import argparse
import json
import os
import re
import signal
import selectors
import subprocess
import time
import uuid
from pathlib import Path
from policy import (Blocked, require, DIGEST, private_directory, read_regular,
                    exclusive_write, encode, sync_dir)

TOOLS=Path(__file__).resolve().parent
REPOSITORY=TOOLS.parents[2]

def docker(args, timeout=10, input_bytes=None, accept_failure=False):
    process=None
    try:
        # No shell, environment dumps, logs, SQL or application module inspection.
        require(input_bytes is None or len(input_bytes)<=4096,'probe_input_limit')
        process=subprocess.Popen(['docker',*args],stdin=subprocess.PIPE if input_bytes else subprocess.DEVNULL,
            stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        if input_bytes:
            process.stdin.write(input_bytes)
            process.stdin.close()
        collected=bytearray()
        deadline=time.monotonic()+timeout
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout,selectors.EVENT_READ)
            while True:
                remaining=deadline-time.monotonic()
                require(remaining>0,'docker_timeout')
                require(bool(selector.select(remaining)),'docker_timeout')
                chunk=os.read(process.stdout.fileno(),min(4096,65537-len(collected)))
                if not chunk:
                    break
                collected.extend(chunk)
                require(len(collected)<=65536,'docker_output_limit')
        code=process.wait(timeout=max(0.01,deadline-time.monotonic()))
        result=subprocess.CompletedProcess(['docker',*args],code,bytes(collected))
    except Exception:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=2)
        raise Blocked('docker_operation_unavailable') from None
    finally:
        if process is not None:
            if process.stdout: process.stdout.close()
            if process.stdin and not process.stdin.closed: process.stdin.close()
    if not accept_failure:
        require(result.returncode==0,'docker_operation_failed')
    return result

def metadata(target,expression):
    return json.loads(docker(['inspect','--format','{{json '+expression+'}}',target]).stdout)

def replace_record(path,value):
    temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.next')
    exclusive_write(temporary,encode(value))
    os.replace(temporary,path)
    sync_dir(path.parent)

def validate_probe(value):
    require(isinstance(value,dict) and value.get('schemaVersion')==1
            and value.get('compiledGuard')=='NOT_VERIFIED'
            and value.get('authenticatedCoverage')=='NOT_TESTED','invalid_probe_result')
    require(value.get('result') in ('PASS','FAIL','BLOCKED'),'invalid_probe_result')
    require(set(value)<= {'schemaVersion','result','checks','compiledGuard','authenticatedCoverage','readiness','reason'},'unexpected_probe_fields')
    require(value.get('readiness') in (None,'PASS'),'invalid_readiness')
    require(value.get('reason') in (None,'unexpected_private_route_response','probe_incomplete','readiness_unavailable_no_database_fallback'),'invalid_probe_reason')
    checks=value.get('checks')
    require(isinstance(checks,list) and len(checks)<=21,'probe_count')
    pairs=set()
    for row in checks:
        require(set(row)=={'route','identity','status','result'},'invalid_probe_fields')
        require(row['route'] in ('list','detail','raw','status','delete','clear','test')
                and row['identity'] in ('anonymous','malformed_cookie','forged_headers')
                and isinstance(row['status'],int) and 100<=row['status']<=599
                and row['result'] in ('PASS','FAIL'),'invalid_probe_check')
        pair=(row['route'],row['identity'])
        require(pair not in pairs,'duplicate_probe_check')
        pairs.add(pair)
    if value['result']=='PASS':
        require(value.get('readiness')=='PASS' and len(pairs)==21
                and all(r['status']==503 and r['result']=='PASS' for r in checks),'incomplete_closure_result')
    return value

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image-id',required=True)
    parser.add_argument('--provenance-report',required=True,type=Path)
    parser.add_argument('--evidence-dir',required=True,type=Path)
    parser.add_argument('--confirm-runtime-check',required=True)
    args=parser.parse_args()
    os.umask(0o077)
    require(bool(DIGEST.fullmatch(args.image_id)) and args.confirm_runtime_check==args.image_id,'explicit_image_confirmation_required')
    require(args.provenance_report.is_absolute() and args.evidence_dir.is_absolute(),'absolute_paths_required')
    require(not any(c in str(args.evidence_dir) for c in ',\n\r'),'unsupported_evidence_path')
    provenance=json.loads(read_regular(args.provenance_report,65536,private=True))
    require(provenance.get('schemaVersion')==1 and provenance.get('result')=='LOCAL_CONSISTENCY_VERIFIED'
            and provenance.get('imageId')==args.image_id and provenance.get('sourceGuard')=='literal_false'
            and provenance.get('compiledGuard')=='NOT_VERIFIED','provenance_prerequisite')
    parent=private_directory(args.evidence_dir.parent)
    evidence=parent/args.evidence_dir.name
    require(not evidence.is_relative_to(REPOSITORY) and not evidence.is_relative_to(Path('/tmp'))
            and not evidence.is_relative_to(Path('/var/tmp')),'durable_external_evidence_required')
    require(not os.path.lexists(evidence),'evidence_exists')
    require(not os.environ.get('DOCKER_HOST') or os.environ['DOCKER_HOST'].startswith('unix://'),'local_docker_required')
    endpoint=json.loads(docker(['context','inspect','--format','{{json .Endpoints.docker.Host}}']).stdout)
    require(isinstance(endpoint,str) and endpoint.startswith('unix://'),'local_docker_required')
    require(json.loads(docker(['image','inspect','--format','{{json .Id}}',args.image_id]).stdout)==args.image_id,'image_identity_mismatch')
    for field,expected in [('Entrypoint',['node','/candidate-launch.mjs']),('WorkingDir','/app'),('User','0:0')]:
        require(json.loads(docker(['image','inspect','--format','{{json .Config.'+field+'}}',args.image_id]).stdout)==expected,'image_configuration_mismatch')
    require(json.loads(docker(['image','inspect','--format','{{json .Config.Volumes}}',args.image_id]).stdout) in (None,{}),'image_volumes_forbidden')
    probe=read_regular(TOOLS/'closure_probe.mjs',65536)
    run=uuid.uuid4().hex
    name='devcaught-closed-check-'+run
    evidence.mkdir(mode=0o700);sync_dir(parent)
    material=evidence/'synthetic-runtime-material'
    material.mkdir(mode=0o700);sync_dir(evidence)
    for filename in ['app_password','better_auth_secret']:
        exclusive_write(material/filename,(os.urandom(32).hex()+'\n').encode())
    report={'schemaVersion':1,'imageId':args.image_id,'container':name,'run':run,
        'result':'BLOCKED','compiledGuard':'NOT_VERIFIED','cleanup':'not_created'}
    state=evidence/'runtime-state.json'
    exclusive_write(state,encode(report))
    cid=None
    def interrupted(*_):
        raise Blocked('interrupted_or_deadline')
    for sig in [signal.SIGINT,signal.SIGTERM,signal.SIGALRM]:
        signal.signal(sig,interrupted)
    signal.alarm(180)
    try:
        report['cleanup']='creation_pending';replace_record(state,report)
        creation=docker(['create','--pull=never','--name',name,'--label','devcaught.closed-check='+run,
            '--network','none','--read-only','--init','--restart=no','--log-driver=none',
            '--cap-drop=ALL','--cap-add=CHOWN','--cap-add=SETUID','--cap-add=SETGID','--cap-add=DAC_OVERRIDE',
            '--security-opt=no-new-privileges','--memory=512m','--cpus=1','--pids-limit=128',
            '--add-host','postgres-dev:127.0.0.1',
            '--tmpfs','/app/data:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=0700',
            '--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777',
            '--mount','type=bind,src='+str(material)+',dst=/run/secrets,readonly',
            '--env','BETTER_AUTH_URL=http://localhost:3000',
            '--env','DEVCAUGHT_DB_PATH=/app/data/closed-check.db',args.image_id],timeout=20)
        identifier=creation.stdout.decode().strip()
        require(bool(re.fullmatch(r'[a-f0-9]{64}',identifier)),'invalid_created_identity')
        cid=identifier
        report['cleanup']='created_stopped';replace_record(state,report)
        host=metadata(cid,'.HostConfig')
        require(host['NetworkMode']=='none' and host['ReadonlyRootfs'] is True
                and host.get('Privileged') is False and not host.get('PortBindings'),'isolation_mismatch')
        mounts=metadata(cid,'.Mounts')
        require(len(mounts)==1 and mounts[0]['Type']=='bind' and mounts[0]['Source']==str(material)
                and mounts[0]['Destination']=='/run/secrets' and mounts[0]['RW'] is False,'unexpected_mount')
        docker(['start',cid],timeout=15)
        report['cleanup']='stop_required';replace_record(state,report)
        result=docker(['exec','-i','--user','1000:1000',cid,'node','--input-type=module','-'],
                      timeout=90,input_bytes=probe,accept_failure=True)
        observed=validate_probe(json.loads(result.stdout))
        require(result.returncode==0 if observed['result']=='PASS' else result.returncode!=0,'probe_exit_mismatch')
        report.update(observed)
    except Exception as error:
        report['result']='BLOCKED'
        report['reason']=str(error) if isinstance(error,Blocked) else 'runtime_check_unavailable'
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGINT,signal.SIG_IGN);signal.signal(signal.SIGTERM,signal.SIG_IGN)
        # Save bounded evidence BEFORE any teardown. Failure preserves resources.
        replace_record(state,report)
        if cid:
            try:
                require(metadata(cid,'.Image')==args.image_id and metadata(cid,'.Name')=='/'+name
                        and metadata(cid,'.Config.Labels').get('devcaught.closed-check')==run,'cleanup_ownership_mismatch')
                docker(['stop','--time','5',cid],timeout=12)
                require(metadata(cid,'.State.Running') is False,'stop_unverified')
                report['cleanup']='stopped_retained'
                replace_record(state,report)
                if report['result']=='PASS':
                    # Only the freshly created, ownership-checked container ID.
                    docker(['rm',cid],timeout=10)
                    report['cleanup']='removed'
                    for filename in ['app_password','better_auth_secret']:
                        (material/filename).unlink()
                    sync_dir(material)
            except Exception:
                report['result']='BLOCKED';report['cleanup']='recovery_required'
        elif report['cleanup']=='creation_pending':
            report['cleanup']='creation_uncertain_preserve_for_review'
        replace_record(state,report)
        exclusive_write(evidence/'result.json',encode(report))
    print(json.dumps({'result':report['result'],'cleanup':report['cleanup'],
        'evidence':str(evidence),'compiledGuard':'NOT_VERIFIED',
        'authenticatedCoverage':'NOT_TESTED'}))
    return 0 if report['result']=='PASS' and report['cleanup']=='removed' else 1

if __name__=='__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        category=str(error) if isinstance(error,Blocked) else 'runtime_prerequisite_unavailable'
        print(json.dumps({'result':'BLOCKED','category':category,'compiledGuard':'NOT_VERIFIED'}))
        raise SystemExit(1)
