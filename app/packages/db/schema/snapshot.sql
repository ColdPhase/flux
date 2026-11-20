-- The schema of a Flux database, one line per object, sorted (#1552, C-68): what an upgraded database and a fresh one must agree on.
-- Read by app/tests/app/released-databases.test.ts and scripts/release/smoke_artifacts.sh; both compare the lines of two databases.
--
-- The schema `public` and the extensions: tables, views and sequences; columns with their type, nullability, default, generation,
-- identity and collation; constraints (not-null ones too), indexes, functions and procedures (by a digest of their whole definition),
-- triggers, enum, domain and composite types, row-level security and its policies. pg-boss's own schema is the library's business.
-- Columns are compared by name, not position: a column a migration added comes last in an old table, which no query can see.
-- Parentheses are dropped from expressions: PostgreSQL prints `(a AND b) AND c` as written, and a database restored from a dump (every
-- backup, every released fixture) prints it re-parsed as `a AND b AND c`; the words, operators and values still must be the same.
-- Not the schema but data: the per-space sequences of task numbers (`project_task_number_<space>`), made by a trigger for each space.
WITH
relations AS (
  SELECT c.oid, c.relname, c.relkind, c.relrowsecurity FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND c.relname NOT LIKE 'project\_task\_number\_%'
),
lines AS (
  SELECT 'extension ' || e.extname || ' ' || e.extversion AS line FROM pg_extension e
  UNION ALL
  SELECT 'relation ' || r.relname || ' ' || r.relkind::text || CASE WHEN r.relrowsecurity THEN ' row-level-security' ELSE '' END FROM relations r
  UNION ALL
  SELECT 'column ' || r.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
    || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
    || coalesce(' default ' || regexp_replace(pg_get_expr(d.adbin, d.adrelid), '[()]', '', 'g'), '')
    || CASE WHEN a.attgenerated <> '' THEN ' generated ' || a.attgenerated::text ELSE '' END
    || CASE WHEN a.attidentity <> '' THEN ' identity ' || a.attidentity::text ELSE '' END
    || CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN ' collate ' || a.attcollation::regcollation::text ELSE '' END
  FROM relations r JOIN pg_attribute a ON a.attrelid = r.oid JOIN pg_type t ON t.oid = a.atttypid
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE r.relkind <> 'S' AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'constraint ' || r.relname || '.' || co.conname || ' ' || regexp_replace(pg_get_constraintdef(co.oid), '[()]', '', 'g')
    || CASE WHEN co.convalidated THEN '' ELSE ' not valid' END
  FROM pg_constraint co JOIN relations r ON r.oid = co.conrelid
  UNION ALL
  SELECT 'index ' || regexp_replace(pg_get_indexdef(i.indexrelid), '[()]', '', 'g') FROM pg_index i JOIN relations r ON r.oid = i.indrelid
  UNION ALL
  SELECT 'function ' || p.oid::regprocedure::text || ' ' || md5(pg_get_functiondef(p.oid)) FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
    AND NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.classid = 'pg_proc'::regclass AND dep.objid = p.oid AND dep.deptype = 'e')
  UNION ALL
  SELECT 'trigger ' || regexp_replace(pg_get_triggerdef(tg.oid), '[()]', '', 'g') || CASE WHEN tg.tgenabled = 'D' THEN ' disabled' ELSE '' END
  FROM pg_trigger tg JOIN relations r ON r.oid = tg.tgrelid WHERE NOT tg.tgisinternal
  UNION ALL
  SELECT 'type ' || t.typname || ' ' || CASE t.typtype
      WHEN 'e' THEN 'enum ' || (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid)
      WHEN 'd' THEN 'domain ' || format_type(t.typbasetype, t.typtypmod)
      ELSE 'composite' END
  FROM pg_type t WHERE t.typnamespace = 'public'::regnamespace AND t.typtype IN ('e', 'd', 'c')
    AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid AND c.relkind <> 'c')
    AND NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.classid = 'pg_type'::regclass AND dep.objid = t.oid AND dep.deptype = 'e')
  UNION ALL
  SELECT 'policy ' || pol.tablename || '.' || pol.policyname || ' ' || pol.cmd || ' ' || array_to_string(pol.roles, ',')
    || ' using ' || regexp_replace(coalesce(pol.qual, ''), '[()]', '', 'g') || ' check ' || regexp_replace(coalesce(pol.with_check, ''), '[()]', '', 'g')
  FROM pg_policies pol WHERE pol.schemaname = 'public'
)
SELECT line FROM lines ORDER BY line COLLATE "C";
