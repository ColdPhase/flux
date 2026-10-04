import type { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { apiEditingOutputBudget,type EditingOutputBudget } from './output.js';
import { editingContextCharge } from './context-charge.js';

export const EDITING_QUEUE_PREFIX='FLUX_LIVE_QUEUE ';
export const EDITING_RESOURCE_GAUGES=[
  'gatePending','gateConnected','wikiConnections','wikiReading','wikiWriting','wikiCursorActive',
  'assemblyCount','assemblyBytes','httpQueued','nativeQueued','wikiOutputQueued','admissionQueued',
  'codecLeases','codecWaiting','codecActive','wikiSqlActive','mapQueued','mapActive','mapSqlActive',
  'mapConnections','mapOperations','mapPendingMovement','mapPendingPresence','externalInputBytes','externalOutputBytes',
] as const;
export type EditingResourceGauge=typeof EDITING_RESOURCE_GAUGES[number];
export type EditingResourceSnapshot=Record<EditingResourceGauge,number>;
type Transport=Pick<Writable,'write'|'writableNeedDrain'|'writableLength'|'writableHighWaterMark'|'writable'|'destroyed'|'writableEnded'|'on'|'off'>;
type Correlation={resourceId:string;generation:string;commandId?:string;interactionId?:string;inputSequence?:number;confirmedSequence?:number};
const API=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const RECORDS=65_536,BYTES=32*1024*1024,LINE=4096;

/** Disabled development measurement only. No sample array, bodies, names, cursors or credentials.
 * A complete actual component snapshot is mandatory; missing counters are never filled with zero.
 * observe() updates every resource peak on mutation. emit() is only initial/receipt/preview/final. */
export class EditingQueueTelemetry {
  private peaks=Object.fromEntries(EDITING_RESOURCE_GAUGES.map(field=>[field,0])) as EditingResourceSnapshot;
  private attempted=0;private retained=0;private dropped=0;private bytes=0;
  private backpressured=false;private invalidSource=false;private finished=false;private initial=false;
  private transportFailed=false;
  private pending:{kind:'wiki'|'map';correlation:Correlation;release:()=>void}|null=null;
  private sampling:NodeJS.Timeout|null=null;
  private transportError=()=>{this.transportFailed=true;};
  constructor(readonly apiInstance:string,private read:()=>EditingResourceSnapshot,private output:Transport=process.stdout,private budget:EditingOutputBudget=apiEditingOutputBudget) {
    if(!API.test(apiInstance))throw new Error('Development telemetry requires its explicit inspected API instance ID');
    output.on('error',this.transportError);
  }
  /** Called synchronously by actual resource owners, including pushes/reserves and shifts/releases. */
  observe=()=>{if(this.finished)return;this.snapshot();};
  private snapshot():EditingResourceSnapshot|null {
    try {
      const value=this.read();
      if(!value||Object.keys(value).length!==EDITING_RESOURCE_GAUGES.length||EDITING_RESOURCE_GAUGES.some(field=>!integer(value[field])))throw new Error('Incomplete actual queue resource snapshot');
      for(const field of EDITING_RESOURCE_GAUGES)this.peaks[field]=Math.max(this.peaks[field],value[field]);
      return value;
    } catch {this.invalidSource=true;return null;}
  }
  private append(kind:'initial'|'wiki'|'map'|'final',correlation:Correlation|null,finalDrained?:boolean,completed?:(success:boolean)=>void) {
    if(this.finished)return false;
    this.attempted++;
    const values=this.snapshot();
    if(!values||this.invalidSource||this.transportFailed||this.output.destroyed||this.output.writableEnded||!this.output.writable){this.dropped++;return false;}
    if(kind!=='final'&&(this.output.writableNeedDrain||this.retained>=RECORDS-1||this.bytes>=BYTES-LINE)) {
      this.backpressured ||=this.output.writableNeedDrain;this.dropped++;return false;
    }
    const peaks=Object.fromEntries(EDITING_RESOURCE_GAUGES.map(field=>[`peak${field[0]!.toUpperCase()}${field.slice(1)}`,this.peaks[field]]));
    const record={schema:1,apiInstance:this.apiInstance,kind,resourceId:correlation?.resourceId??null,generation:correlation?.generation??null,
      ...values,...peaks,attemptedRecords:this.attempted,retainedRecords:this.retained+1,droppedRecords:this.dropped,backpressured:this.backpressured,
      ...(correlation?.commandId===undefined?{}:{commandId:correlation.commandId}),...(correlation?.interactionId===undefined?{}:{interactionId:correlation.interactionId}),
      ...(correlation?.inputSequence===undefined?{}:{inputSequence:correlation.inputSequence}),...(correlation?.confirmedSequence===undefined?{}:{confirmedSequence:correlation.confirmedSequence}),
      ...(kind==='final'?{finalDrained:finalDrained===true&&EDITING_RESOURCE_GAUGES.every(field=>values[field]===0)}:{})};
    const raw=JSON.stringify(record)+'\n';const size=Buffer.byteLength(raw);
    const final=kind==='final';
    if(size>LINE||this.bytes+size>(final?BYTES:BYTES-LINE)||this.retained>=(final?RECORDS:RECORDS-1)){this.dropped++;return false;}
    try {
      const ready=this.output.write(EDITING_QUEUE_PREFIX+raw,(error?:Error|null)=>{if(error)this.transportFailed=true;completed?.(!error);});
      // write(false) still accepted this exact record. Every later snapshot keeps the cumulative fact.
      this.retained++;this.bytes+=size;this.backpressured ||=!ready;
      return ready||!final;
    } catch {this.dropped++;return false;}
  }
  start(){if(this.initial||this.finished)return false;this.initial=true;const accepted=this.append('initial',null);
    this.sampling=setInterval(()=>{const pending=this.pending;this.pending=null;if(pending){try{this.emit(pending.kind,pending.correlation);}finally{pending.release();}}},200);this.sampling.unref();return accepted;}
  /** At most one ordinary frame each200ms. Coalesced interactions keep their latency rows;
   * optional row-correlated depths remain null. They are not telemetry write attempts. */
  schedule(kind:'wiki'|'map',correlation:Correlation){
    if(!this.initial||this.finished)return;
    let release=()=>{};
    try {
      if(!this.valid(correlation))throw new Error('Invalid closed telemetry correlation');
      release=this.budget.reserve(2*editingContextCharge(correlation));
      const old=this.pending;this.pending={kind,correlation:{...correlation},release};old?.release();
    }catch{release();this.attempted++;this.dropped++;}
  }
  private valid(correlation:Correlation){return UUID.test(correlation.resourceId)&&UUID.test(correlation.generation)&&!Object.keys(correlation).some(field=>!['resourceId','generation','commandId','interactionId','inputSequence','confirmedSequence'].includes(field))
      &&(correlation.commandId===undefined||UUID.test(correlation.commandId))&&(correlation.interactionId===undefined||UUID.test(correlation.interactionId))
      &&(correlation.inputSequence===undefined||integer(correlation.inputSequence))&&(correlation.confirmedSequence===undefined||integer(correlation.confirmedSequence));}
  emit(kind:'wiki'|'map',correlation:Correlation) {
    if(!this.initial||this.finished)return false;
    if(!this.valid(correlation)) {
      this.attempted++;this.dropped++;return false;
    }
    return this.append(kind,correlation);
  }
  /** Call ONLY after actual producers/operations/transports have closed and settled.
   * Waits outside SQL for an empty public stdout buffer. A final cannot conceal its first write(false):
   * its <=4096B line must fit strictly below an empty standard Node stdout high-water mark.
   * A missing/failed final or an unexpected terminal write(false) is an incomplete measurement. */
  async finish(drained:boolean,deadlineMs=1500) {
    if(this.finished||!this.initial||!integer(deadlineMs)||deadlineMs>2000)return false;
    this.stopSampling();
    const deadline=Date.now()+deadlineMs;
    while((this.output.writableNeedDrain||this.output.writableLength>0)&&Date.now()<deadline)await delay(10);
    if(this.transportFailed||this.output.destroyed||this.output.writableEnded||!this.output.writable||this.output.writableNeedDrain||this.output.writableLength>0||this.output.writableHighWaterMark<=LINE+EDITING_QUEUE_PREFIX.length) {
      this.attempted++;this.dropped++;this.backpressured ||=this.output.writableNeedDrain;this.finished=true;this.output.off('error',this.transportError);return false;
    }
    let settle=(_success:boolean)=>{};const completion=new Promise<boolean>(resolve=>{settle=resolve;});
    const accepted=this.append('final',null,drained,settle);this.finished=true;
    if(!accepted){this.output.off('error',this.transportError);return false;}
    const flushed=await Promise.race([completion,delay(Math.max(0,deadline-Date.now())).then(()=>false)]);
    this.output.off('error',this.transportError);
    // The collector also requires actual clean/nonforced API exit+stdout EOF. A terminal write(false),
    // callback error or deadline cannot retroactively amend the final JSON and is irrevocably incomplete.
    return flushed&&!this.transportFailed&&!this.invalidSource&&!this.output.destroyed&&this.output.writableLength===0;
  }
  stopSampling(){if(this.sampling)clearInterval(this.sampling);this.sampling=null;this.pending?.release();this.pending=null;}
  get counts(){return{attemptedRecords:this.attempted,retainedRecords:this.retained,droppedRecords:this.dropped,rawBytes:this.bytes,backpressured:this.backpressured};}
}
export function developmentQueueTelemetry(env:NodeJS.ProcessEnv,developmentEnabled:boolean,read:()=>EditingResourceSnapshot,output:Transport=process.stdout) {
  if(!developmentEnabled||env.FLUX_DEVELOPMENT_LIVE_EDITING_TELEMETRY!=='1')return null;
  const id=env.FLUX_DEVELOPMENT_LIVE_EDITING_API_INSTANCE;
  if(!id||!API.test(id))throw new Error('Explicit inspected FLUX_DEVELOPMENT_LIVE_EDITING_API_INSTANCE is required for development telemetry');
  return new EditingQueueTelemetry(id,read,output);
}
