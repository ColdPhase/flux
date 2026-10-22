import { createHash } from 'node:crypto';
import { ServiceUnavailableError, type MapNativeChange, type ThoughtRecord, type SketchRecord, type MapJournalLink } from '@flux/core';

export const mapHash=(generation:string,sequence:number)=>createHash('sha256').update(`${generation}:${sequence}`).digest('hex');
const date=(value:Date|string)=>{const result=value instanceof Date?value:new Date(value);if(!Number.isFinite(result.getTime()))throw new Error('Invalid map journal timestamp');return result;};
function thought(row:ThoughtRecord):ThoughtRecord {
  if(!row.source)return {...row,createdAt:date(row.createdAt),updatedAt:date(row.updatedAt),source:null};
  const source=row.source as NonNullable<ThoughtRecord['source']> & {authorKind?:'human'|'agent';projectMessageId?:string|null};
  const authorKind=source.authorKind??'human';
  if(authorKind!=='human'&&authorKind!=='agent')throw new ServiceUnavailableError('Invalid bounded map journal','EDITING_MAP_CAPACITY');
  return {...row,createdAt:date(row.createdAt),updatedAt:date(row.updatedAt),source:{...source,authorKind,
    projectMessageId:source.projectMessageId??null,sentAt:date(source.sentAt)}};
}
function sketch(row:SketchRecord):SketchRecord {
  return {...row,createdAt:date(row.createdAt),updatedAt:date(row.updatedAt),copied:row.copied?{...row.copied,at:date(row.copied.at)}:null};
}
const link=(row:MapJournalLink)=>({...row,createdAt:date(row.createdAt)});
export function decodeMapChange(value:Record<string,unknown>):MapNativeChange {
  if(!Array.isArray(value.thoughts)||!Array.isArray(value.links)||!Array.isArray(value.dependencies)||!Array.isArray(value.removedThoughts)||!Array.isArray(value.clearedLeaseIds)
    ||value.thoughts.length>2000||value.links.length>20_000||value.dependencies.length>2000)throw new ServiceUnavailableError('Invalid bounded map journal','EDITING_MAP_CAPACITY');
  const c=value as MapNativeChange;
  return {...c,sketchBefore:c.sketchBefore?sketch(c.sketchBefore):null,sketchAfter:c.sketchAfter?sketch(c.sketchAfter):null,
    thoughts:c.thoughts.map(t=>({...t,before:t.before?thought(t.before):null,after:t.after?thought(t.after):null})),
    links:c.links.map(l=>({...l,before:l.before?link(l.before):null,after:l.after?link(l.after):null}))};
}
