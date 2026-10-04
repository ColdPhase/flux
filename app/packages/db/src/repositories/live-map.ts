import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { LiveMapPosition } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { EDITING_CHANNEL } from './live-editing.js';

export class LiveMapCapacityError extends Error { readonly code='EDITING_MAP_CAPACITY'; }
const h=schema.mapLiveHeads; const j=schema.mapLiveJournal; const v=schema.mapLiveObjectVersions;
const g=schema.mapLiveGestures; const p=schema.mapLivePresence;
interface Actor { kind:'human'|'agent';id:string }
interface Who { actorId:string;sessionId:string }
export function liveMapRows<Change extends Record<string,unknown>>(db:DbExecutor, decode:(value:Record<string,unknown>)=>Change) {
  const head = async (sketchId:string) => { const [row]=await db.select().from(h).where(eq(h.sketchId,sketchId)).for('update');return row??null; };
  const journal = (row:typeof j.$inferSelect) => ({...row,change:decode(row.change)});
  const alive = sql`LEAST(clock_timestamp()+interval '5 seconds',(SELECT expires_at FROM auth_sessions WHERE id=${g.sessionId}))`;
  return {
    head,
    async ensureHead(sketchId:string,workspaceId:string) {
      await db.insert(h).values({sketchId,workspaceId,generation:randomUUID()}).onConflictDoNothing();return (await head(sketchId))!;
    },
    async append(room:typeof h.$inferSelect,actor:Actor,commandId:string,fingerprint:string,change:Change) {
      if (Buffer.byteLength(JSON.stringify(change))>8*1024*1024 || room.sequence>=Number.MAX_SAFE_INTEGER) throw new LiveMapCapacityError('The bounded map journal is full');
      const sequence=room.sequence+1;
      await db.insert(j).values({sketchId:room.sketchId,generation:room.generation,sequence,actorKind:actor.kind,actorId:actor.id,commandId,fingerprint,change});
      await db.update(h).set({sequence,updatedAt:sql`clock_timestamp()`}).where(eq(h.sketchId,room.sketchId));
      await db.execute(sql`SELECT pg_notify(${EDITING_CHANNEL},${room.sketchId})`);
      return sequence;
    },
    async snapshotCapacity(sketchId:string) {
      const t=schema.sketchThoughts;const l=schema.sketchLinks;
      const [thoughts]=await db.select({n:sql<number>`count(*)::int`,bytes:sql<number>`COALESCE(sum(octet_length(to_jsonb(${t})::text)),0)::bigint`}).from(t).where(eq(t.sketchId,sketchId));
      const [links]=await db.select({n:sql<number>`count(*)::int`,bytes:sql<number>`COALESCE(sum(octet_length(to_jsonb(${l})::text)),0)::bigint`}).from(l).where(eq(l.sketchId,sketchId));
      if(thoughts!.n*48+links!.n*8+1024>60_000||Number(thoughts!.bytes)>2*1024*1024||Number(links!.bytes)>2*1024*1024)
        throw new LiveMapCapacityError('The native snapshot reached its bounded representation capacity');
    },
    async after(sketchId:string,generation:string,sequence:number) {
      const [row]=await db.select().from(j).where(and(eq(j.sketchId,sketchId),eq(j.generation,generation),gt(j.sequence,sequence))).orderBy(asc(j.sequence)).limit(1);
      return row?journal(row):null;
    },
    async command(actor:Actor,commandId:string) {
      const [row]=await db.select().from(j).where(and(eq(j.actorKind,actor.kind),eq(j.actorId,actor.id),eq(j.commandId,commandId)));return row?journal(row):null;
    },
    async originals(sketchId:string,generation:string,ids:string[]) {
      const [size]=await db.select({bytes:sql<number>`COALESCE(sum(octet_length(${j.change}::text)),0)::bigint`}).from(j)
        .where(and(eq(j.sketchId,sketchId),eq(j.generation,generation),inArray(j.commandId,ids)));
      if(Number(size!.bytes)>4*1024*1024)throw new LiveMapCapacityError('The bounded undo journal preparation is full');
      return (await db.select().from(j).where(and(eq(j.sketchId,sketchId),eq(j.generation,generation),inArray(j.commandId,ids))).limit(200)).map(journal);
    },
    async undone(sketchId:string,generation:string,sequences:number[]) {
      return db.select().from(schema.mapLiveUndone).where(and(eq(schema.mapLiveUndone.sketchId,sketchId),eq(schema.mapLiveUndone.generation,generation),inArray(schema.mapLiveUndone.originalSequence,sequences)));
    },
    async markUndone(sketchId:string,generation:string,sequences:number[],inverseSequence:number) {
      await db.insert(schema.mapLiveUndone).values(sequences.map(originalSequence=>({sketchId,generation,originalSequence,inverseSequence})));
    },
    async version(kind:'thought'|'link',objectId:string) {
      const [row]=await db.select().from(v).where(and(eq(v.kind,kind),eq(v.objectId,objectId))).for('update');return row??null;
    },
    async putVersion(kind:'thought'|'link',objectId:string,sketchId:string,version:number) {
      await db.insert(v).values({kind,objectId,sketchId,version}).onConflictDoUpdate({target:[v.kind,v.objectId],set:{version},setWhere:and(eq(v.sketchId,sketchId),sql`${v.version} < ${version}`)});
    },
    async dependencyLinks(sketchId:string,thoughtIds:string[],linkIds:string[]=[]) {
      if(!thoughtIds.length&&!linkIds.length)return [];
      const l=schema.sketchLinks; const where=and(eq(l.sketchId,sketchId),or(thoughtIds.length?inArray(l.fromId,thoughtIds):undefined,thoughtIds.length?inArray(l.toId,thoughtIds):undefined,linkIds.length?inArray(l.id,linkIds):undefined));
      // Count/size before loading any graph-dependent rows into JavaScript.
      const [size]=await db.select({n:sql<number>`count(*)::int`,bytes:sql<number>`COALESCE(sum(octet_length(to_jsonb(${l})::text)),0)::int`}).from(l).where(where);
      if(size!.n>20_000||size!.bytes>2*1024*1024)throw new LiveMapCapacityError('The affected dependency bag reached its bounded capacity');
      const rows=await db.select({link:l,epoch:v.version}).from(l).leftJoin(v,and(eq(v.kind,'link'),eq(v.objectId,l.id))).where(where).orderBy(asc(l.id));
      return rows.map(({link,epoch})=>({id:link.id,sketchId:link.sketchId,fromId:link.fromId,toId:link.toId,label:link.label,createdAt:link.createdAt,epoch:epoch??1,createdBy:link.createdByUserId?{kind:'human' as const,id:link.createdByUserId}:{kind:'agent' as const,id:link.createdByAgentId!}}));
    },
    async expire(sketchId:string) { await db.delete(g).where(and(eq(g.sketchId,sketchId),sql`${g.expiresAt}<=clock_timestamp()`));await db.delete(p).where(and(eq(p.sketchId,sketchId),sql`${p.expiresAt}<=clock_timestamp()`)); },
    async gestures(sketchId:string,generation:string) {
      return db.select({lease:g,name:schema.authUsers.name}).from(g).innerJoin(schema.authUsers,eq(schema.authUsers.id,g.actorId))
        .innerJoin(schema.authSessions,and(eq(schema.authSessions.id,g.sessionId),gt(schema.authSessions.expiresAt,sql`clock_timestamp()`)))
        .where(and(eq(g.sketchId,sketchId),eq(g.generation,generation),gt(g.expiresAt,sql`clock_timestamp()`))).orderBy(asc(g.leaseId)).limit(32);
    },
    async gesture(leaseId:string) { const [row]=await db.select().from(g).where(eq(g.leaseId,leaseId)).for('update');return row??null; },
    async capacity(kind:'gesture'|'presence',sketchId:string) {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'flux.map.'+kind+'.capacity'},0))`);
      const table=kind==='gesture'?g:p;
      await db.delete(table).where(sql`${table.expiresAt}<=clock_timestamp()`);
      const result=await db.execute<{total:number;room:number}>(sql`SELECT count(*)::int total,count(*) FILTER(WHERE sketch_id=${sketchId})::int room FROM ${table}`);
      if(result.rows[0]!.total>=2048||result.rows[0]!.room>=32)throw new LiveMapCapacityError('The bounded map presence capacity is busy');
    },
    async insertGesture(sketchId:string,generation:string,who:Who,gestureId:string,thoughts:{id:string;expectedVersion:number}[]) {
      const [row]=await db.insert(g).values({leaseId:randomUUID(),sketchId,generation,gestureId,actorId:who.actorId,sessionId:who.sessionId,thoughts,
        expiresAt:sql`LEAST(clock_timestamp()+interval '5 seconds',(SELECT expires_at FROM auth_sessions WHERE id=${who.sessionId}))`}).returning();return row!;
    },
    async bindMove(leaseId:string,connectionId:string,sequence:number,positions:LiveMapPosition[]) {
      await db.update(g).set({connectionId,sequence,positions,expiresAt:alive}).where(eq(g.leaseId,leaseId));
    },
    async removeGesture(leaseId:string) {await db.delete(g).where(eq(g.leaseId,leaseId));},
    async clearAffected(sketchId:string,thoughtIds:string[]) {
      const rows=await db.select().from(g).where(eq(g.sketchId,sketchId)).limit(32);
      const affected=rows.filter(row=>row.thoughts.some(thought=>thoughtIds.includes(thought.id))).map(row=>row.leaseId);
      if(affected.length)await db.delete(g).where(inArray(g.leaseId,affected));return affected;
    },
    async setPresence(sketchId:string,generation:string,who:Who,connectionId:string,selected:string[],cursor:{x:number;y:number}|null) {
      const [existing]=await db.select().from(p).where(eq(p.connectionId,connectionId));
      await db.insert(p).values({connectionId,sketchId,generation,actorId:who.actorId,sessionId:who.sessionId,selected,cursor,
        expiresAt:sql`LEAST(clock_timestamp()+interval '5 seconds',(SELECT expires_at FROM auth_sessions WHERE id=${who.sessionId}))`})
        .onConflictDoUpdate({target:p.connectionId,set:{selected,cursor,expiresAt:sql`LEAST(clock_timestamp()+interval '5 seconds',(SELECT expires_at FROM auth_sessions WHERE id=${who.sessionId}))`},
          setWhere:and(eq(p.sketchId,sketchId),eq(p.generation,generation),eq(p.actorId,who.actorId),eq(p.sessionId,who.sessionId))});
      return !!existing;
    },
    async presence(sketchId:string,generation:string) {
      return db.select({presence:p,name:schema.authUsers.name}).from(p).innerJoin(schema.authUsers,eq(schema.authUsers.id,p.actorId))
        .innerJoin(schema.authSessions,and(eq(schema.authSessions.id,p.sessionId),gt(schema.authSessions.expiresAt,sql`clock_timestamp()`)))
        .where(and(eq(p.sketchId,sketchId),eq(p.generation,generation),gt(p.expiresAt,sql`clock_timestamp()`))).orderBy(asc(p.connectionId)).limit(32);
    },
    async hasPresence(connectionId:string) { const [row]=await db.select().from(p).where(eq(p.connectionId,connectionId));return !!row; },
    async disconnect(sketchId:string,who:Who,connectionId:string) {
      await db.delete(p).where(and(eq(p.sketchId,sketchId),eq(p.actorId,who.actorId),eq(p.sessionId,who.sessionId),eq(p.connectionId,connectionId)));
      await db.delete(g).where(and(eq(g.sketchId,sketchId),eq(g.actorId,who.actorId),eq(g.sessionId,who.sessionId),eq(g.connectionId,connectionId)));
    },
    async notify(sketchId:string) {await db.execute(sql`SELECT pg_notify(${EDITING_CHANNEL},${sketchId})`);},
  };
}
