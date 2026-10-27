// One kernel lock across evidence roots and across acceptance/recovery/release.
import {constants,openSync,closeSync,fstatSync,lstatSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {ensurePrivateDirectory} from './evidence.mjs';
export function acquireCoordinationLock() {
  if(process.platform!=='linux')throw new Error('Linux flock coordination is required');
  const directory=join(homedir(),'.local/state/devcaught');
  ensurePrivateDirectory(directory);
  const path=join(directory,'private-api-acceptance.lock');
  const fd=openSync(path,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
  try {
    const info=fstatSync(fd);
    if(!info.isFile()||info.uid!==process.getuid()||(info.mode&0o077)||info.nlink!==1)throw new Error('Unsafe coordination lock');
    // flock operates on the inherited open-file description. The parent retains
    // its descriptor until process exit, including while awaiting child work.
    const result=spawnSync('flock',['--exclusive','--nonblock','3'],{stdio:['ignore','ignore','ignore',fd],timeout:5000});
    if(result.error||result.status!==0)throw new Error('Private API coordination unavailable or busy');
    const current=lstatSync(path);
    if(realpathSync(path)!==path||current.ino!==info.ino||current.dev!==info.dev)throw new Error('Coordination lock changed');
    process.once('exit',()=>closeSync(fd));
    return fd;
  }catch(error){closeSync(fd);throw error;}
}
