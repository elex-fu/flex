/** Trusted host code: stdin is a generated operation request, never a repository script. */
export const CONTROLLED_RESTORE_HELPER = String.raw`
import os, sys, json, stat, hashlib, base64, errno
LIMIT=64*1024*1024
class Failure(Exception): pass
def fail(code): raise Failure(code)
def identity(s): return {'dev':str(s.st_dev),'ino':str(s.st_ino)}
def stamp(s): return ':'.join(str(x) for x in (s.st_dev,s.st_ino,s.st_mode,s.st_size,s.st_mtime_ns,s.st_ctime_ns))
def valid(path):
    if not isinstance(path,str) or not path or '\0' in path or path.startswith('/') or any(x in ('','.','..') or x.lower()=='.git' for x in path.split('/')): fail('UNSUPPORTED_PATH')
    return [os.fsencode(x) for x in path.split('/')]
def root(cap):
    fd=os.open(cap['path'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    if identity(os.fstat(fd))!={k:cap[k] for k in ('dev','ino')}: os.close(fd); fail('ROOT_IDENTITY_CHANGED')
    return fd
def linked(cap,parts,chain):
    fd=root(cap)
    try:
        if identity(os.fstat(fd))!=chain[0]: fail('PARENT_CHANGED')
        for i,name in enumerate(parts):
            nxt=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd); os.close(fd); fd=nxt
            if identity(os.fstat(fd))!=chain[i+1]: fail('PARENT_CHANGED')
    finally: os.close(fd)
def parent(cap,path):
    parts=valid(path); fd=root(cap); chain=[identity(os.fstat(fd))]
    try:
        for name in parts[:-1]:
            nxt=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd); os.close(fd); fd=nxt; chain.append(identity(os.fstat(fd)))
        return fd,parts[-1],parts[:-1],chain
    except: os.close(fd); raise
def read_all(fd):
    data=bytearray()
    while True:
        part=os.read(fd,1024*1024)
        if not part: break
        data.extend(part)
        if len(data)>LIMIT: fail('RESTORE_BUDGET_EXCEEDED')
    return bytes(data)
def state_at(fd,name):
    try: before=os.stat(name,dir_fd=fd,follow_symlinks=False)
    except FileNotFoundError: return {'kind':'absent'}
    if stat.S_ISDIR(before.st_mode): return {'kind':'directory','stamp':stamp(before)}
    if stat.S_ISLNK(before.st_mode):
        data=os.fsencode(os.readlink(name,dir_fd=fd)); mode='120000'; kind='symlink'
    elif stat.S_ISREG(before.st_mode):
        if before.st_size>LIMIT: fail('RESTORE_BUDGET_EXCEEDED')
        filefd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
        try:
            if stamp(before)!=stamp(os.fstat(filefd)): fail('FILE_READ_RACE')
            data=read_all(filefd)
            if stamp(before)!=stamp(os.fstat(filefd)): fail('FILE_READ_RACE')
        finally: os.close(filefd)
        mode='100755' if before.st_mode&0o111 else '100644'; kind='file'
    else: fail('UNSUPPORTED_FILE_TYPE')
    after=os.stat(name,dir_fd=fd,follow_symlinks=False)
    if stamp(before)!=stamp(after): fail('FILE_READ_RACE')
    return {'kind':kind,'mode':mode,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'stamp':stamp(after)}
def inspect_file(cap,path):
    try: fd,name,parts,chain=parent(cap,path)
    except FileNotFoundError: return {'kind':'absent'}
    try: result=state_at(fd,name); linked(cap,parts,chain); return result
    finally: os.close(fd)
def equal(actual,expected):
    if actual!=expected: fail('FILE_COLLISION')
def names(step):
    if len(step)!=36 or any(c not in 'abcdef0123456789-' for c in step): fail('INVALID_OPERATION_ID')
    prefix=os.fsencode('.flyx-revert-'+step)
    return prefix+b'.tmp',prefix+b'.owner',prefix+b'.lock'
def same_inode(fd,a,b):
    try: return identity(os.stat(a,dir_fd=fd,follow_symlinks=False))==identity(os.stat(b,dir_fd=fd,follow_symlinks=False))
    except FileNotFoundError: return False
def artifacts(fd,step,index=False,destination=None):
    temp,owner,lock=names(step); result={'temporary':state_at(fd,temp),'owner':state_at(fd,owner),'sameInode':same_inode(fd,temp,owner),'ownerMatchesTarget':bool(destination) and same_inode(fd,owner,destination)}
    if index: result.update({'lockOwner':state_at(fd,lock),'indexLock':state_at(fd,b'index.lock'),'sameLockInode':same_inode(fd,lock,b'index.lock')})
    return result
def bytes_at(fd,name):
    st=os.stat(name,dir_fd=fd,follow_symlinks=False)
    if stat.S_ISLNK(st.st_mode): return os.fsencode(os.readlink(name,dir_fd=fd))
    filefd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
    try: return read_all(filefd)
    finally: os.close(filefd)
def after_owned_cleanup(before,after):
    if {k:v for k,v in before.items() if k!='stamp'}!={k:v for k,v in after.items() if k!='stamp'} or before.get('stamp','').split(':')[:-1]!=after.get('stamp','').split(':')[:-1]: fail('FILE_COLLISION')
def cleanup(fd,step,data,expected,index=False,destination=None):
    actual=artifacts(fd,step,index,destination)
    if actual!=expected: fail('RESTORE_ARTIFACT_COLLISION')
    temp,owner,lock=names(step)
    if actual['temporary']['kind']!='absent' or actual['owner']['kind']!='absent':
        if actual['temporary']['kind']=='absent' and actual['ownerMatchesTarget'] and bytes_at(fd,owner)==data:
            os.unlink(owner,dir_fd=fd)
        else:
            if not actual['sameInode'] or actual['temporary']['kind'] not in ('file','symlink'): fail('RESTORE_ARTIFACT_COLLISION')
            if not data.startswith(bytes_at(fd,temp)): fail('RESTORE_ARTIFACT_COLLISION')
            os.unlink(temp,dir_fd=fd); os.unlink(owner,dir_fd=fd)
    if index:
        if actual['indexLock']['kind']!='absent':
            if not actual['sameLockInode'] or actual['lockOwner']['kind']!='file' or bytes_at(fd,lock)!=step.encode(): fail('INDEX_LOCK_COLLISION')
            os.unlink(b'index.lock',dir_fd=fd)
        if actual['lockOwner']['kind']!='absent':
            if actual['lockOwner']['kind']!='file' or bytes_at(fd,lock)!=step.encode(): fail('INDEX_LOCK_COLLISION')
            os.unlink(lock,dir_fd=fd)
    return actual['ownerMatchesTarget']
def syncdir(fd): os.fsync(fd)
def write_temp(fd,step,data,mode,fault):
    temp,owner,_=names(step)
    if mode=='120000':
        if b'\0' in data: fail('UNSUPPORTED_SYMLINK_TARGET')
        os.symlink(data,temp,dir_fd=fd)
        os.link(temp,owner,src_dir_fd=fd,dst_dir_fd=fd,follow_symlinks=False)
        return temp,owner
    filefd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
    try:
        os.link(temp,owner,src_dir_fd=fd,dst_dir_fd=fd,follow_symlinks=False)
        if fault=='half_write':
            os.write(filefd,data[:max(1,len(data)//2)]); os.fsync(filefd); fail('INJECTED_HALF_WRITE')
        position=0
        while position<len(data): position+=os.write(filefd,data[position:])
        os.fchmod(filefd,0o755 if mode=='100755' else 0o644); os.fsync(filefd)
    finally: os.close(filefd)
    return temp,owner
def index_state(cap):
    fd=root(cap)
    try:
        state=state_at(fd,b'index')
        if state['kind']=='absent': return state,hashlib.sha256(b'index-absent').hexdigest()
        if state['kind']!='file': fail('UNSUPPORTED_INDEX')
        data=bytes_at(fd,b'index')
        if state!=state_at(fd,b'index'): fail('FILE_READ_RACE')
        return state,hashlib.sha256(b'index\0'+data).hexdigest()
    finally: os.close(fd)
def git_entry(cap):
    fd=root(cap)
    try:
        state=state_at(fd,b'.git')
        if state['kind']=='directory': state['stamp']=':'.join(state['stamp'].split(':')[:2])
        return state
    finally: os.close(fd)
def run(req):
    op=req['op']
    if not all(hasattr(os,x) for x in ('O_NOFOLLOW','O_DIRECTORY')) or os.open not in os.supports_dir_fd or os.rename not in os.supports_dir_fd: fail('CONTROLLED_RESTORE_UNSUPPORTED')
    if op=='probe': return {'supported':True}
    if op=='identify':
        result={}
        for key,path in (('workspace',req['workspacePath']),('gitDirectory',req['gitPath'])):
            canonical=os.path.realpath(path); fd=os.open(canonical,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try: result[key]={'path':canonical,**identity(os.fstat(fd))}
            finally: os.close(fd)
        result['gitEntry']=git_entry(result['workspace'])
        return result
    caps=req['capabilities']; workspace=caps['workspace']; gitcap=caps['gitDirectory']
    if git_entry(workspace)!=caps['gitEntry']: fail('WORKSPACE_BINDING_CHANGED')
    if op=='inspect':
        files={path:inspect_file(workspace,path) for path in req['paths']}; found={}
        for item in req.get('artifacts',[]):
            if item['kind']=='index': fd=root(gitcap); destination=b'index'
            else:
                try: fd,destination,parts,chain=parent(workspace,item['path'])
                except FileNotFoundError: found[item['stepId']]={'temporary':{'kind':'absent'},'owner':{'kind':'absent'},'sameInode':False,'ownerMatchesTarget':False}; continue
            try: found[item['stepId']]=artifacts(fd,item['stepId'],item['kind']=='index',destination)
            finally: os.close(fd)
        state,dig=index_state(gitcap)
        return {'files':files,'artifacts':found,'indexState':state,'indexDigest':dig}
    data=base64.b64decode(req.get('dataBase64',''),validate=True)
    if len(data)>LIMIT: fail('RESTORE_BUDGET_EXCEEDED')
    target=req.get('target',{})
    if target.get('sha256') and hashlib.sha256(data).hexdigest()!=target['sha256']: fail('TARGET_OBJECT_CORRUPT')
    if req.get('fault')=='permission_denied': raise OSError(errno.EACCES,'injected')
    if req.get('fault')=='disk_full': raise OSError(errno.ENOSPC,'injected')
    if op=='cleanup':
        if req['originalKind']=='index': fd=root(gitcap); name=b'index'
        else: fd,name,parts,chain=parent(workspace,req['path'])
        try:
            if req['originalKind']=='index': linked(gitcap,[],[identity(os.fstat(fd))])
            else: linked(workspace,parts,chain)
            equal(state_at(fd,name),req['expected'])
            cleanup(fd,req['artifactStepId'],data,req['artifact'],req['originalKind']=='index',name); syncdir(fd)
            if req['originalKind']=='index': linked(gitcap,[],[identity(os.fstat(fd))])
            else: linked(workspace,parts,chain)
            return {'cleanedStepId':req['artifactStepId'],'file':state_at(fd,name)}
        finally: os.close(fd)
    if op=='index':
        fd=root(gitcap); temp,owner,lock=names(req['stepId'])
        try:
            initial,initialdig=index_state(gitcap); equal(initial,req['expected'])
            if initialdig!=req['expectedIndexDigest']: fail('INDEX_COLLISION')
            changed=cleanup(fd,req['stepId'],data,req['artifact'],True,b'index')
            if changed:
                updated,_=index_state(gitcap); after_owned_cleanup(initial,updated); req['expected']=updated
            lockfd=os.open(lock,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
            try: os.write(lockfd,req['stepId'].encode()); os.fsync(lockfd)
            finally: os.close(lockfd)
            try: os.link(lock,b'index.lock',src_dir_fd=fd,dst_dir_fd=fd,follow_symlinks=False)
            except FileExistsError: os.unlink(lock,dir_fd=fd); fail('INDEX_LOCK_COLLISION')
            state,dig=index_state(gitcap)
            equal(state,req['expected']);
            if dig!=req['expectedIndexDigest']: fail('INDEX_COLLISION')
            temp,owner=write_temp(fd,req['stepId'],data,'100644',req.get('fault'))
            permission=(int(state['stamp'].split(':')[2])&0o777) if state['kind']=='file' else 0o600
            preparedfd=os.open(temp,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
            try: os.fchmod(preparedfd,permission); os.fsync(preparedfd)
            finally: os.close(preparedfd)
            linked(gitcap,[],[identity(os.fstat(fd))]); state2,dig2=index_state(gitcap)
            if state2!=state or dig2!=dig: fail('INDEX_COLLISION')
            os.replace(temp,b'index',src_dir_fd=fd,dst_dir_fd=fd); syncdir(fd)
            if req.get('fault')=='after_replace': fail('INJECTED_AFTER_REPLACE')
            if not same_inode(fd,lock,b'index.lock'): fail('INDEX_LOCK_COLLISION')
            os.unlink(owner,dir_fd=fd); os.unlink(b'index.lock',dir_fd=fd); os.unlink(lock,dir_fd=fd); syncdir(fd)
            final,finaldig=index_state(gitcap)
            if finaldig!=hashlib.sha256(b'index\0'+data).hexdigest(): fail('INDEX_COLLISION')
            return {'indexState':final,'indexDigest':finaldig}
        finally: os.close(fd)
    fd,name,parts,chain=parent(workspace,req['path'])
    try:
        equal(state_at(fd,name),req['expected']); linked(workspace,parts,chain)
        if op=='mkdir':
            if req['expected']['kind']!='absent': fail('FILE_COLLISION')
            os.mkdir(name,0o755,dir_fd=fd); syncdir(fd)
        elif target['kind']=='absent':
            if req['expected']['kind'] not in ('file','symlink','absent'): fail('UNSUPPORTED_DELETE')
            if req['expected']['kind']!='absent': os.unlink(name,dir_fd=fd); syncdir(fd)
        else:
            changed=cleanup(fd,req['stepId'],data,req['artifact'],False,name)
            if changed:
                updated=state_at(fd,name); after_owned_cleanup(req['expected'],updated); req['expected']=updated
            temp,owner=write_temp(fd,req['stepId'],data,target['mode'],req.get('fault'))
            linked(workspace,parts,chain); equal(state_at(fd,name),req['expected'])
            os.replace(temp,name,src_dir_fd=fd,dst_dir_fd=fd); syncdir(fd)
            if req.get('fault')=='after_replace': fail('INJECTED_AFTER_REPLACE')
            os.unlink(owner,dir_fd=fd); syncdir(fd)
        linked(workspace,parts,chain)
        if req.get('fault')=='after_mutation': fail('INJECTED_AFTER_MUTATION')
        final=state_at(fd,name)
        if target['kind']!='directory' and any(final.get(key)!=target.get(key) for key in ('kind','mode','sha256','bytes')): fail('FILE_COLLISION')
        return {'file':final}
    finally: os.close(fd)
try:
    request=json.load(sys.stdin); print(json.dumps({'ok':True,'result':run(request)},separators=(',',':')))
except Failure as error: print(json.dumps({'ok':False,'code':str(error)},separators=(',',':')))
except OSError as error:
    code={errno.EACCES:'RESTORE_PERMISSION_DENIED',errno.EPERM:'RESTORE_PERMISSION_DENIED',errno.ENOSPC:'RESTORE_DISK_FULL',errno.ELOOP:'UNSAFE_PARENT',errno.ENOTDIR:'UNSAFE_PARENT',errno.ENOENT:'PARENT_MISSING',errno.EEXIST:'RESTORE_ARTIFACT_COLLISION'}.get(error.errno,'RESTORE_IO_FAILED')
    print(json.dumps({'ok':False,'code':code},separators=(',',':')))
except Exception: print(json.dumps({'ok':False,'code':'RESTORE_HELPER_FAILED'},separators=(',',':')))
`;
