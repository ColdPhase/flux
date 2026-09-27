import { pgTable, text, timestamp, uuid, integer, jsonb } from 'drizzle-orm/pg-core';

export const samples = pgTable('samples', {
  id: uuid('id').primaryKey(),
  title: text('title').notNull(),
  createdBy: text('created_by').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable('events', {
  id: uuid('id').primaryKey(),
  kind: text('kind').notNull(),
  objectId: uuid('object_id').notNull(),
  actorId: text('actor_id').notNull(),
  data: jsonb('data').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey(),
  eventId: uuid('event_id').notNull().references(() => events.id),
  state: text('state').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sampleResults = pgTable('sample_results', {
  sampleId: uuid('sample_id').primaryKey().references(() => samples.id),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  workerId: text('worker_id').notNull(),
});
