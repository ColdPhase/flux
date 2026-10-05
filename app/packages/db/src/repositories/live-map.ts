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
  // This rows instance retains original raw/decoded journals through the caller's undo transaction.
  // Current graph preparation must fit beside them in the same shared24MiB reservation.
  let originalsRetained=0;
  const head = async (sketchId:string) => { const [row]=await db.select().from(h).where(eq(h.sketchId,sketchId)).for('update');return row??null; };
  const journal = (row:typeof j.$inferSelect) => ({...row,change:decode(row.change)});
  const alive = sql`LEAST(clock_timestamp()+interval '5 seconds',(SELECT expires_at FROM auth_sessions WHERE id=${g.sessionId}))`;
  return {
    head,
    /** Non-locking: whether this map has an established live room. An ordinary map takes no live preparation. */
    async exists(sketchId:string) { const [row]=await db.select({sketchId:h.sketchId}).from(h).where(eq(h.sketchId,sketchId)).limit(1);return !!row; },
    async ensureHead(sketchId:string,workspaceId:string) {
      await db.insert(h).values({sketchId,workspaceId,generation:randomUUID()}).onConflictDoNothing();return (await head(sketchId))!;
    },
    async append(room:Pick<typeof h.$inferSelect,'workspaceId'|'sketchId'|'generation'|'sequence'>,actor:Actor,commandId:string,fingerprint:string,change:Change) {
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
      // Count parsed JSON structure in SQL BEFORE pg transfers/parses any complete JSONB journal.
      // Match the conservative object/key/UTF-16 model, including array indices. Raw+decoded
      // graphs get two allowances; four serialized-byte allowances cover transport text and
      // temporary canonical/string comparisons. No original independently receives24MiB.
      const measured=await db.execute<{charge:string}>(sql`
        WITH RECURSIVE originals(value) AS (SELECT change FROM map_live_journal WHERE sketch_id=${sketchId} AND generation=${generation} AND command_id=ANY(${sql.param(ids)}::uuid[])),
        walk(value,key) AS (
          SELECT value,''::text FROM originals
          UNION ALL SELECT child.value,child.key FROM walk w CROSS JOIN LATERAL (
            SELECT value,key FROM jsonb_each(CASE WHEN jsonb_typeof(w.value)='object' THEN w.value ELSE '{}'::jsonb END)
            UNION ALL SELECT value,(ordinality-1)::text AS key FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.value)='array' THEN w.value ELSE '[]'::jsonb END) WITH ORDINALITY
          ) child
        ) SELECT COALESCE(sum((CASE jsonb_typeof(value) WHEN 'object' THEN 256 WHEN 'array' THEN 256 WHEN 'string' THEN 2*octet_length(value#>>'{}') ELSE 16 END)
          +(CASE WHEN key='' THEN 0 ELSE 128+2*octet_length(key) END)),0)::text AS charge FROM walk`);
      originalsRetained=65_536+8_192*ids.length+2*Number(measured.rows[0]!.charge)+4*Number(size!.bytes);
      if(!Number.isSafeInteger(originalsRetained)||originalsRetained>24*1024*1024)throw new LiveMapCapacityError('The aggregate undo journals reached their bounded parsed representation capacity');
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
    /** Count the affected representation before loading/cloning journal graph rows.
     * Native journal reads links incident to explicit thoughts/links, adds their endpoints, then
     * reads that dependency bag. Undo already has its exact original thoughts and reads ONE bag.
     * 192 visits/thought includes raw+normalized before/after, native result and dependency wrappers;
     * 128/link includes raw+normalized before/after and four {id,epoch} dependency entries.
     * Byte overhead allows four32-property objects per row plus references/wrappers. SQL serialized
     * strings (including displayed author names) get fourfold UTF-16 before/after allowance and each
     * thought gets a separately bounded new1000-unit text allowance. These conservative maxima share24MiB. */
    async journalCapacity(sketchId:string,thoughtIds:string[],linkIds:string[]=[],mode:'native'|'undo'='native') {
      const result=await db.execute<{thoughts:number;links:number;bytes:string}>(sql`
        WITH selected(id) AS (SELECT unnest(${sql.param(thoughtIds)}::uuid[])),
        first_links AS (SELECT l.* FROM sketch_links l WHERE l.sketch_id=${sketchId} AND (l.from_id IN(SELECT id FROM selected) OR l.to_id IN(SELECT id FROM selected) OR l.id=ANY(${sql.param(linkIds)}::uuid[]))),
        affected(id) AS (SELECT id FROM selected UNION SELECT from_id FROM first_links WHERE ${mode==='native'} UNION SELECT to_id FROM first_links WHERE ${mode==='native'}),
        links AS (SELECT l.* FROM sketch_links l WHERE l.sketch_id=${sketchId} AND (l.from_id IN(SELECT id FROM affected) OR l.to_id IN(SELECT id FROM affected) OR l.id=ANY(${sql.param(linkIds)}::uuid[])))
        SELECT (SELECT count(*)::int FROM affected) AS thoughts,(SELECT count(*)::int FROM links)+cardinality(${sql.param(linkIds)}::uuid[]) AS links,
          ((SELECT COALESCE(sum(octet_length(to_jsonb(t)::text)+COALESCE(octet_length(u.name),0)+COALESCE(octet_length(a.name),0)),0) FROM sketch_thoughts t
            LEFT JOIN auth_users u ON u.id=t.created_by_user_id LEFT JOIN agents a ON a.id=t.created_by_agent_id WHERE t.sketch_id=${sketchId} AND t.id IN(SELECT id FROM affected))
          +(SELECT COALESCE(sum(octet_length(to_jsonb(l)::text)),0) FROM links l))::text AS bytes`);
      const size=result.rows[0]!;
      const visits=1024+192*size.thoughts+128*size.links;
      const retained=originalsRetained+65_536+4*Number(size.bytes)+17_408*(size.thoughts+size.links)+2_000*size.thoughts;
      if(visits>60_000||retained>24*1024*1024)throw new LiveMapCapacityError('The full affected journal preparation reached its bounded representation capacity');
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
    /** One final SQL-clock observation immediately before a protected transient callback.
     * Policy/session locks have already been acquired; this closes natural TTL/session expiry during an await. */
    async currentTransientFence(who:Who,sketchId:string,generation:string) {
      const result=await db.execute<{recipientAlive:boolean;gestureIds:string[];presenceIds:string[]}>(sql`
        WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at)
        SELECT EXISTS(SELECT 1 FROM auth_sessions a,moment m WHERE a.id=${who.sessionId} AND a.user_id=${who.actorId} AND a.expires_at>m.at) AS "recipientAlive",
          ARRAY(SELECT g.lease_id::text FROM map_live_gestures g JOIN auth_sessions a ON a.id=g.session_id AND a.user_id=g.actor_id,moment m
            WHERE g.sketch_id=${sketchId} AND g.generation=${generation} AND g.expires_at>m.at AND a.expires_at>m.at ORDER BY g.lease_id LIMIT 32) AS "gestureIds",
          ARRAY(SELECT p.connection_id::text FROM map_live_presence p JOIN auth_sessions a ON a.id=p.session_id AND a.user_id=p.actor_id,moment m
            WHERE p.sketch_id=${sketchId} AND p.generation=${generation} AND p.expires_at>m.at AND a.expires_at>m.at ORDER BY p.connection_id LIMIT 32) AS "presenceIds"`);
      return result.rows[0]!;
    },
    async hasPresence(connectionId:string) { const [row]=await db.select().from(p).where(eq(p.connectionId,connectionId));return !!row; },
    async disconnect(sketchId:string,who:Who,connectionId:string) {
      await db.delete(p).where(and(eq(p.sketchId,sketchId),eq(p.actorId,who.actorId),eq(p.sessionId,who.sessionId),eq(p.connectionId,connectionId)));
      await db.delete(g).where(and(eq(g.sketchId,sketchId),eq(g.actorId,who.actorId),eq(g.sessionId,who.sessionId),eq(g.connectionId,connectionId)));
    },
    async notify(sketchId:string) {await db.execute(sql`SELECT pg_notify(${EDITING_CHANNEL},${sketchId})`);},
  };
}
