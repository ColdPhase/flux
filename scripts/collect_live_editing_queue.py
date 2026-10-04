#!/usr/bin/env python3
"""Bounded actual Docker stdout collection; never certifies missing records as zeros."""
import argparse, hashlib, json, math, os, re, selectors, signal, stat, subprocess, time, uuid
from pathlib import Path
PREFIX=b'FLUX_LIVE_QUEUE '
MAX_BYTES=32*1024*1024
MAX_RECORDS=65536
LINE_LIMIT=4096
HANDOFF_LIMIT=4096
GAUGES=('gatePending','gateConnected','wikiConnections','wikiReading','wikiWriting','wikiCursorActive','assemblyCount','assemblyBytes','httpQueued','nativeQueued','wikiOutputQueued','admissionQueued','codecLeases','codecWaiting','codecActive','wikiSqlActive','mapQueued','mapActive','mapSqlActive','mapConnections','mapOperations','mapPendingMovement','mapPendingPresence','externalInputBytes','externalOutputBytes')
PEAKS=tuple('peak'+s[0].upper()+s[1:] for s in GAUGES)
COUNTERS=('attemptedRecords','retainedRecords','droppedRecords')

def strict(raw):
    def pairs(items):
        result={}
        for key,value in items:
            if key in result: raise ValueError('duplicate JSON key')
            result[key]=value
        return result
    def nonfinite(_): raise ValueError('nonfinite JSON')
    return json.loads(raw,object_pairs_hook=pairs,parse_constant=nonfinite)

def bounded_regular(path,limit):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as stream:
        before=os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size>limit: raise ValueError('bounded regular file required')
        raw=stream.read(limit+1)
        after=os.fstat(stream.fileno()); named=os.stat(path,follow_symlinks=False)
        if len(raw)>limit or len(raw)!=after.st_size or before.st_size!=after.st_size or before.st_mtime_ns!=after.st_mtime_ns or (after.st_dev,after.st_ino)!=(named.st_dev,named.st_ino): raise ValueError('handoff changed')
        return raw

def atomic(path,value):
    raw=(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n').encode()
    if len(raw)>HANDOFF_LIMIT: raise ValueError('handoff too large')
    temporary=path.parent/('.'+path.name+'.'+uuid.uuid4().hex+'.tmp')
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as out: out.write(raw); out.flush(); os.fsync(out.fileno())
    os.replace(temporary,path)

def integer(x): return type(x) is int and 0<=x<=2**53-1

def validate_marker(raw,inventory):
    marker=strict(raw)
    fields={'schema','measurement_id','source_sha','driver_sha256','api_instances','planned_cases','completed_case_count','scheduled_rows_written','teardown_complete','finished_at'}
    cases=['map-50-drag-1','map-50-drag-50','map-500-drag-1','map-500-drag-50','map-500-drag-200','wiki-10000-editor','wiki-10000-reader','wiki-100000-editor','wiki-100000-reader']
    if not isinstance(marker,dict) or set(marker)!=fields or type(marker['schema']) is not int or marker['schema']!=1 or marker['source_sha']!=inventory['source_sha'] or marker['driver_sha256']!=inventory['driver_sha256'] or marker['api_instances']!=inventory['api_instances'] or marker['planned_cases']!=cases or not integer(marker['completed_case_count']) or marker['completed_case_count']>len(cases) or not integer(marker['scheduled_rows_written']) or marker['scheduled_rows_written']>2160 or type(marker['teardown_complete']) is not bool or type(marker['finished_at']) not in (int,float) or not math.isfinite(marker['finished_at']) or marker['finished_at']<0 or not isinstance(marker['measurement_id'],str) or str(uuid.UUID(marker['measurement_id']))!=marker['measurement_id']:
        raise ValueError('closed marker binding invalid')
    return marker

def validate_record(record,producer):
    required=set(GAUGES+PEAKS+COUNTERS)|{'schema','apiInstance','kind','resourceId','generation','backpressured'}
    optional={'commandId','interactionId','inputSequence','confirmedSequence','finalDrained'}
    if not isinstance(record,dict) or not required.issubset(record) or set(record)-required-optional or type(record['schema']) is not int or record['schema']!=1 or record['apiInstance']!=producer or record['kind'] not in ('initial','wiki','map','final') or any(not integer(record[k]) for k in GAUGES+PEAKS+COUNTERS) or type(record['backpressured']) is not bool: raise ValueError('closed primitive producer record required')
    if record['kind'] in ('initial','final'):
        if record['resourceId'] is not None or record['generation'] is not None or set(record)&(optional-{'finalDrained'}): raise ValueError('terminal resource fields forbidden')
    else:
        for key in ('resourceId','generation'):
            if not isinstance(record[key],str) or str(uuid.UUID(record[key]))!=record[key]: raise ValueError('canonical resource UUID required')
    for key in ('commandId','interactionId'):
        if key in record and (not isinstance(record[key],str) or str(uuid.UUID(record[key]))!=record[key]): raise ValueError('canonical correlation UUID required')
    for key in ('inputSequence','confirmedSequence'):
        if key in record and not integer(record[key]): raise ValueError('correlation sequence invalid')
    if record['kind']=='final':
        if type(record.get('finalDrained')) is not bool: raise ValueError('terminal drain observation required')
    elif 'finalDrained' in record: raise ValueError('only final certifies drain')
    return record

def terminal_state(records,expected):
    previous={}; finals={}; counts={}; incomplete=False
    required=set(GAUGES+PEAKS+COUNTERS)|{'schema','apiInstance','kind','resourceId','generation','backpressured'}
    optional={'commandId','interactionId','inputSequence','confirmedSequence','finalDrained'}
    for record in records:
        if not isinstance(record,dict) or not required.issubset(record) or set(record)-required-optional or type(record['schema']) is not int or record['schema']!=1 or record['apiInstance'] not in expected or record['kind'] not in ('initial','wiki','map','final') or any(not integer(record[k]) for k in GAUGES+PEAKS+COUNTERS) or type(record['backpressured']) is not bool: raise ValueError('invalid telemetry record')
        instance=record['apiInstance']; old=previous.get(instance)
        if instance in finals or old is None and record['kind']!='initial' or old is not None and record['kind']=='initial': raise ValueError('initial/final lifecycle invalid')
        counts[instance]=counts.get(instance,0)+1
        if record['retainedRecords']!=counts[instance] or record['attemptedRecords']!=record['retainedRecords']+record['droppedRecords']: raise ValueError('capture counter mismatch')
        if old and (any(record[k]<old[k] for k in PEAKS+COUNTERS) or old['backpressured'] and not record['backpressured']): raise ValueError('cumulative counters reset')
        if any(record[p]<record[g] for g,p in zip(GAUGES,PEAKS)): raise ValueError('peak below gauge')
        if record['kind'] in ('initial','final'):
            if record['resourceId'] is not None or record['generation'] is not None or set(record)&(optional-{'finalDrained'}): raise ValueError('terminal record resource fields')
        else:
            for key in ('resourceId','generation'):
                if str(uuid.UUID(record[key]))!=record[key]: raise ValueError('canonical UUID required')
        for key in ('commandId','interactionId'):
            if key in record and str(uuid.UUID(record[key]))!=record[key]: raise ValueError('canonical correlation UUID required')
        for key in ('inputSequence','confirmedSequence'):
            if key in record and not integer(record[key]): raise ValueError('correlation sequence invalid')
        incomplete |= record['droppedRecords']>0 or record['backpressured'] or record['externalInputBytes']>MAX_BYTES or record['externalOutputBytes']>MAX_BYTES or record['peakExternalInputBytes']>MAX_BYTES or record['peakExternalOutputBytes']>MAX_BYTES
        if record['kind']=='final':
            if type(record.get('finalDrained')) is not bool: raise ValueError('missing final drain')
            if record['finalDrained'] and any(record[g]!=0 for g in GAUGES): raise ValueError('false drained assertion')
            finals[instance]=record
        elif 'finalDrained' in record: raise ValueError('only final can certify drain')
        previous[instance]=record
    if set(finals)!=set(expected): raise ValueError('missing inventoried final')
    return {'dropped':sum(finals[i]['droppedRecords'] for i in expected),'backpressured':any(finals[i]['backpressured'] for i in expected),'drained':all(finals[i]['finalDrained'] for i in expected),'incomplete':incomplete}

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('directory',type=Path); parser.add_argument('inventory',type=Path); parser.add_argument('--timeout',type=int,default=1200)
    args=parser.parse_args(); directory=args.directory.resolve(); inventory=strict(bounded_regular(args.inventory,65536))
    expected=inventory['api_instances']; containers=inventory['containers']; source=inventory['source_sha']
    if not isinstance(expected,list) or not 1<=len(expected)<=32 or any(not isinstance(i,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}',i) for i in expected) or len(set(expected))!=len(expected) or set(containers)!=set(expected) or not re.fullmatch(r'[a-f0-9]{40}',source) or not re.fullmatch(r'[a-f0-9]{64}',inventory['driver_sha256']): raise ValueError('actual inventory invalid')
    for name,cid in containers.items():
        observed=strict(subprocess.check_output(['docker','inspect',cid],timeout=10))[0]
        env=observed['Config']['Env']; binding='FLUX_DEVELOPMENT_LIVE_EDITING_API_INSTANCE='+name
        if observed['Id']!=cid or not observed['State']['Running'] or binding not in env or 'FLUX_DEVELOPMENT_LIVE_EDITING_TELEMETRY=1' not in env: raise ValueError('actual producer inventory no longer matches')
    for name in ('actual-queue.jsonl','queue-seal.json','measurement-finished.json'):
        if (directory/name).exists(): raise ValueError('stale evidence')
    fd=os.open(directory/'actual-queue.jsonl',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    selector=selectors.DefaultSelector(); processes={}; buffers={}; discarded=set(); records=[]; size=0; count=0; error=None; reason='drained'; marker_raw=None; marker=None; stop=None; shutdown_deadline=None
    began=time.monotonic(); deadline=began+args.timeout
    for name,cid in containers.items():
        p=subprocess.Popen(['docker','logs','--follow',cid],stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        processes[name]=p; buffers[name]=b''; selector.register(p.stdout,selectors.EVENT_READ,name)
    atomic(directory/'collector-ready.json',{'schema':1,'source_sha':source,'api_instances':expected,'inventory_sha256':hashlib.sha256(bounded_regular(args.inventory,65536)).hexdigest()})
    interrupted=[]
    def signal_handler(signum,_frame): interrupted.append(signum)
    signal.signal(signal.SIGTERM,signal_handler); signal.signal(signal.SIGINT,signal_handler)
    with os.fdopen(fd,'wb') as raw:
        while True:
            now=time.monotonic()
            if interrupted or now>=deadline:
                error=error or 'collector interrupted or total deadline'; reason='timeout'; break
            if marker_raw is None and (directory/'measurement-finished.json').exists():
                try:
                    candidate_marker=bounded_regular(directory/'measurement-finished.json',HANDOFF_LIMIT)
                    candidate=validate_marker(candidate_marker,inventory)
                    marker_raw=candidate_marker; marker=candidate
                    stop=subprocess.Popen(['docker','stop','--time','8',*containers.values()],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); shutdown_deadline=now+12
                except Exception as exc:
                    error=str(exc); reason='collector-error'; break
            for key,_ in selector.select(.05):
                name=key.data; chunk=os.read(key.fileobj.fileno(),8192)
                if not chunk:
                    if buffers[name] and name not in discarded:
                        error=error or 'unterminated stdout line'; reason='collector-error'
                    selector.unregister(key.fileobj); key.fileobj.close(); continue
                for part in chunk.splitlines(keepends=True):
                    ended=part.endswith(b'\n')
                    if name in discarded:
                        if ended: discarded.remove(name)
                        continue
                    buffer=buffers[name]+part
                    if len(buffer)>LINE_LIMIT+len(PREFIX):
                        if buffer.startswith(PREFIX): error=error or 'telemetry line exceeded limit'; reason='size-limit'
                        buffers[name]=b''
                        if not ended: discarded.add(name)
                        continue
                    if not ended: buffers[name]=buffer; continue
                    buffers[name]=b''
                    if not buffer.startswith(PREFIX): continue
                    line=buffer[len(PREFIX):]
                    if len(line)>LINE_LIMIT or count>=MAX_RECORDS or size+len(line)>MAX_BYTES:
                        error=error or 'bounded raw evidence limit'; reason='size-limit'; continue
                    try:
                        record=strict(line)
                        validate_record(record,name)
                    except Exception as exc:
                        error=error or ('invalid producer record '+hashlib.sha256(line).hexdigest()); reason='collector-error'; continue
                    raw.write(line); size+=len(line); count+=1; records.append(record)
            if marker_raw is not None and stop.poll() is not None and not selector.get_map():
                if stop.returncode: error=error or 'graceful container stop failed'; reason='collector-error'
                for p in processes.values():
                    try: p.wait(timeout=max(.01,min(.5,(shutdown_deadline or time.monotonic())-time.monotonic())))
                    except subprocess.TimeoutExpired: error=error or 'stdout process not settled'; reason='collector-error'
                if any(p.returncode!=0 for p in processes.values()): error=error or 'stdout collector did not reach clean EOF'; reason='collector-error'
                break
            if shutdown_deadline is not None and now>=shutdown_deadline:
                error=error or 'producer/collector drain timed out'; reason='timeout'; break
            if marker_raw is None and not selector.get_map():
                error=error or 'producer EOF before measurement finished'; reason='collector-error'; break
        raw.flush(); os.fsync(raw.fileno())
    for p in processes.values():
        if p.poll() is None:
            p.terminate()
            try: p.wait(timeout=.5)
            except subprocess.TimeoutExpired: p.kill(); p.wait(timeout=.5)
    selector.close()
    if stop is not None and stop.poll() is None:
        stop.terminate()
        try: stop.wait(timeout=.5)
        except subprocess.TimeoutExpired: stop.kill(); stop.wait(timeout=.5)
    result=None
    try: result=terminal_state(records,expected)
    except Exception as exc: error=error or str(exc); reason='collector-error' if reason=='drained' else reason
    raw=bounded_regular(directory/'actual-queue.jsonl',MAX_BYTES)
    if marker_raw is not None and result is not None:
        seal={'schema':1,'measurement_id':marker['measurement_id'],'source_sha':source,'api_instances':expected,'measurement_finished_sha256':hashlib.sha256(marker_raw).hexdigest(),'raw_path':'actual-queue.jsonl','raw_bytes':len(raw),'raw_sha256':hashlib.sha256(raw).hexdigest(),'record_count':count,'complete':not error and not result['incomplete'] and result['drained'],'dropped_records':result['dropped'],'backpressured':result['backpressured'],'final_drained':result['drained'],'end_reason':reason}
        atomic(directory/'queue-seal.json',seal)
    atomic(directory/'collector-result.json',{'schema':1,'source_sha':source,'records':count,'bytes':len(raw),'marker_received':marker_raw is not None,'complete':result is not None and not error and not result['incomplete'] and result['drained'],'error':error})
    return 0 if result is not None and not error and not result['incomplete'] and result['drained'] else 1
if __name__=='__main__': raise SystemExit(main())
