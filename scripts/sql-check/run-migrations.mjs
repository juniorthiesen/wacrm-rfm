import { createDb, applyMigrations } from "./harness.mjs";

const db = await createDb();
const results = await applyMigrations(db);
for (const r of results) console.log(r.ok ? "OK   " : "FALHA", r.file, r.ok ? "" : `-> ${r.error}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} migracoes aplicadas`);

// Do the objects my migrations depend on exist?
const need = ["contacts", "contact_rfm_metrics", "orders", "automations", "automation_steps", "email_config", "email_suppressions", "email_messages", "automation_enrollments"];
const { rows } = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`, [need]);
const have = new Set(rows.map((r) => r.table_name));
console.log("tabelas necessarias:", need.map((t) => `${t}:${have.has(t) ? "sim" : "NAO"}`).join(" "));
await db.close();
