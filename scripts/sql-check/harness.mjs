// Isolated, in-memory Postgres (PGlite) to validate the wacrm migrations.
// Nothing here touches any real database. Stubs replace the Supabase-only bits.
import { PGlite } from "@electric-sql/pglite";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Default: ../../supabase/migrations relative to this file; override with MIGRATIONS_DIR when the folder was copied elsewhere.
export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL("../../supabase/migrations", import.meta.url));

export async function createDb() {
  const db = new PGlite({ extensions: { uuid_ossp, unaccent } });
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
    CREATE SCHEMA auth;
    CREATE SCHEMA extensions;
    CREATE SCHEMA storage;
    CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE storage.objects (id uuid DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql AS
      $$ SELECT string_to_array(name, '/') $$;
    CREATE PUBLICATION supabase_realtime;
    -- Supabase grants the API roles access to everything created in public.
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
    GRANT SELECT ON auth.users TO authenticated, service_role;
  `);
  return db;
}

export async function applyMigrations(db, { only } = {}) {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const results = [];
  for (const file of files) {
    if (only && !only(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    try {
      await db.exec(sql);
      results.push({ file, ok: true });
    } catch (err) {
      results.push({ file, ok: false, error: String(err.message ?? err).split("\n")[0].slice(0, 220) });
    }
  }
  return results;
}
