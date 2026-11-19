import { createDb, applyMigrations } from "./harness.mjs";

const db = await createDb();
const migr = await applyMigrations(db, { only: (f) => !/^(018|019|020)_/.test(f) });
const bad = migr.filter((m) => !m.ok);
if (bad.length) { console.log("migracoes com falha:", bad); process.exit(1); }

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log("  ok   ", name); } else { fail++; console.log("  FALHA", name, detail); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `\n      esperado ${JSON.stringify(want)}\n      obtido   ${JSON.stringify(got)}`);
const rows = async (sql, p) => (await db.query(sql, p)).rows;
const fails = async (sql, p) => { try { await db.query(sql, p); return null; } catch (e) { return String(e.message).split("\n")[0]; } };

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const AUTO_A = "00000000-0000-0000-0000-0000000000a1";
const AUTO_B = "00000000-0000-0000-0000-0000000000b1";
const cid = (n) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;

await db.exec(`
  INSERT INTO auth.users (id, email) VALUES ('${A}', 'a@t.co'), ('${B}', 'b@t.co');
  INSERT INTO automations (id, user_id, name, trigger_type, trigger_config) VALUES
    ('${AUTO_A}', '${A}', 'regua A', 'recency_reached', '{}'),
    ('${AUTO_B}', '${B}', 'regua B', 'recency_reached', '{}');
`);

// contact id, tenant, phone, name, email, opted_out, recency
const people = [
  [1, A, "5547991110001", "Ana", "ana@x.com", false, 100],
  [2, A, "5547991110002", "Bia", "bia@x.com", false, 200],
  [3, A, "5547991110003", "Ana duplicada", "ana@x.com", false, 150],
  [4, A, "5547991110004", "Cris", "cris@x.com", false, 50],
  [5, A, "5547991110005", "Dani", "dani@x.com", false, 400],
  [6, A, "5547991110006", "Eva", "eva@x.com", true, 120],
  [7, A, "5547991110007", "Fabi", "fabi@x.com", false, 130],
  [8, A, "5547991110008", "Sem email", null, false, 110],
  [9, A, "5547991110009", "Email ruim", "invalid-email", false, 111],
  [10, A, null, "Gil so e-mail", "gil@x.com", false, 95],
  [11, A, "5547991110011", "Hugo", " Hugo@X.com ", false, 99],
  [12, A, "5547991110012", "Ivo", "ivo@x.com", false, 105],
  [13, B, "5511991110013", "Ana de B", "ana@x.com", false, 100],
];
for (const [n, user, phone, name, email, opted, rec] of people) {
  await db.query(`INSERT INTO contacts (id, user_id, phone, name, email, opted_out) VALUES ($1,$2,$3,$4,$5,$6)`, [cid(n), user, phone, name, email, opted]);
  await db.query(`INSERT INTO contact_rfm_metrics (contact_id, user_id, recency_days) VALUES ($1,$2,$3)`, [cid(n), user, rec]);
}
await db.query(`INSERT INTO email_suppressions (user_id, email, reason, source) VALUES ($1,'fabi@x.com','unsubscribed','link')`, [A]);

console.log("\n[053] contatos sem telefone e restricoes");
eq("contato sem telefone foi aceito (phone agora e opcional)", (await rows(`SELECT phone FROM contacts WHERE id=$1`, [cid(10)]))[0].phone, null);
ok("e-mail de supressao em maiuscula e recusado", (await fails(`INSERT INTO email_suppressions (user_id,email,reason) VALUES ($1,'Maius@X.com','manual')`, [A]))?.includes("check"));
ok("motivo de supressao invalido e recusado", (await fails(`INSERT INTO email_suppressions (user_id,email,reason) VALUES ($1,'z@x.com','spam')`, [A]))?.includes("check"));
ok("status invalido em email_messages e recusado", (await fails(`INSERT INTO email_messages (user_id,to_email,subject,status) VALUES ($1,'a@x.com','s','enviado')`, [A]))?.includes("check"));
ok("categoria invalida em email_messages e recusada", (await fails(`INSERT INTO email_messages (user_id,to_email,subject,category) VALUES ($1,'a@x.com','s','promo')`, [A]))?.includes("check"));
await db.query(`INSERT INTO email_config (user_id, from_email) VALUES ($1,'ecom@x.com')`, [A]);
ok("so existe 1 configuracao de e-mail por usuario", (await fails(`INSERT INTO email_config (user_id, from_email) VALUES ($1,'outro@x.com')`, [A]))?.includes("unique") || false);
eq("defaults de email_config", (await rows(`SELECT daily_limit, marketing_min_gap_days, is_active, provider FROM email_config WHERE user_id=$1`, [A]))[0], { daily_limit: 150, marketing_min_gap_days: 3, is_active: false, provider: "resend" });

console.log("\n[054] recency_candidates (janela 90-364)");
const cand = await rows(`SELECT contact_email, recency_days, contact_name FROM recency_candidates($1,$2,90,364,100)`, [A, AUTO_A]);
eq("elegiveis, dedupe por e-mail e ordem (mais recente primeiro)", cand.map((r) => [r.contact_email, r.recency_days]), [["gil@x.com", 95], ["hugo@x.com", 99], ["ana@x.com", 100], ["ivo@x.com", 105], ["bia@x.com", 200]]);
ok("duplicata de e-mail ficou com o contato MAIS RECENTE (Ana, nao 'Ana duplicada')", cand.find((r) => r.contact_email === "ana@x.com").contact_name === "Ana");
ok("e-mail normalizado (espacos e maiusculas)", cand.some((r) => r.contact_email === "hugo@x.com"));
ok("contato so com e-mail (sem telefone) e elegivel", cand.some((r) => r.contact_email === "gil@x.com"));
const excluded = ["cris@x.com", "dani@x.com", "eva@x.com", "fabi@x.com", "invalid-email"];
ok("fora da janela, opt-out, bloqueado e e-mail invalido sao excluidos", excluded.every((e) => !cand.some((r) => r.contact_email === e)));
ok("contato sem e-mail e excluido", !cand.some((r) => r.contact_name === "Sem email"));
eq("isolamento: a lista do cliente B so tem o contato dele", (await rows(`SELECT contact_name FROM recency_candidates($1,$2,90,364,100)`, [B, AUTO_B])).map((r) => r.contact_name), ["Ana de B"]);
eq("limite respeitado e ordem mantida", (await rows(`SELECT contact_email FROM recency_candidates($1,$2,90,364,2)`, [A, AUTO_A])).map((r) => r.contact_email), ["gil@x.com", "hugo@x.com"]);
eq("limite 0 nao devolve nada", (await rows(`SELECT 1 FROM recency_candidates($1,$2,90,364,0)`, [A, AUTO_A])).length, 0);
eq("recency_candidates_count bate com a lista", Number((await rows(`SELECT recency_candidates_count($1,$2,90,364) AS n`, [A, AUTO_A]))[0].n), 5);

console.log("\n[054] protecao contra RFM defasado (comprou recentemente)");
{
  const C = "00000000-0000-0000-0000-00000000000c";
  const AUTO_C = "00000000-0000-0000-0000-0000000000c1";
  await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${C}', 'c@t.co');
    INSERT INTO automations (id, user_id, name, trigger_type) VALUES ('${AUTO_C}', '${C}', 'regua C', 'recency_reached');`);
  // todos com RFM "parado ha 100 dias" (snapshot defasado), so os pedidos diferem
  const cc = (n) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, "0")}`;
  const who = [[1, "velho@c.com"], [2, "comprou-contato@c.com"], [3, "comprou-email@c.com"], [4, "pendente@c.com"], [5, "compra-antiga@c.com"]];
  for (const [n, email] of who) {
    await db.query(`INSERT INTO contacts (id, user_id, phone, email) VALUES ($1,$2,$3,$4)`, [cc(n), C, `55479900000${n}`, email]);
    await db.query(`INSERT INTO contact_rfm_metrics (contact_id, user_id, recency_days) VALUES ($1,$2,100)`, [cc(n), C]);
  }
  const o = (contact, email, status, daysAgo, ext) => db.query(
    `INSERT INTO orders (user_id, contact_id, external_order_id, platform, status, total_amount, customer_email, ordered_at)
     VALUES ($1,$2,$3,'woocommerce',$4,100,$5, now() - make_interval(days => $6))`, [C, contact, ext, status, email, daysAgo]);
  await o(cc(2), "comprou-contato@c.com", "wc-enviado", 5, "c1");   // comprou ha 5 dias, casado por contato
  await o(null, "COMPROU-EMAIL@c.com", "completed", 3, "c2");        // comprou ha 3 dias, casado so por e-mail
  await o(cc(4), "pendente@c.com", "pending", 5, "c3");              // pedido NAO pago nao exclui
  await o(cc(5), "compra-antiga@c.com", "completed", 120, "c4");     // compra de 120 dias atras (fora da janela de 90) nao exclui
  const got = (await rows(`SELECT contact_email FROM recency_candidates($1,$2,90,364,100)`, [C, AUTO_C])).map((r) => r.contact_email).sort();
  eq("quem comprou dentro da janela some, mesmo com o RFM defasado", got, ["compra-antiga@c.com", "pendente@c.com", "velho@c.com"]);
  eq("o contador aplica a mesma protecao", Number((await rows(`SELECT recency_candidates_count($1,$2,90,364) AS n`, [C, AUTO_C]))[0].n), 3);
}

console.log("\n[054] inscricao unica");
await db.query(`INSERT INTO automation_enrollments (user_id, automation_id, contact_id, email, cohort, recency_days) VALUES ($1,$2,$3,'ivo@x.com','treatment',105)`, [A, AUTO_A, cid(12)]);
eq("quem ja esta inscrito sai da lista de elegiveis", (await rows(`SELECT contact_email FROM recency_candidates($1,$2,90,364,100)`, [A, AUTO_A])).map((r) => r.contact_email), ["gil@x.com", "hugo@x.com", "ana@x.com", "bia@x.com"]);
eq("...e do contador", Number((await rows(`SELECT recency_candidates_count($1,$2,90,364) AS n`, [A, AUTO_A]))[0].n), 4);
eq("...mas continua elegivel em OUTRA automacao (a inscricao e por automacao)", Number((await rows(`SELECT recency_candidates_count($1,$2,90,364) AS n`, [A, "00000000-0000-0000-0000-0000000000ff"]))[0].n), 5);
ok("segunda inscricao do mesmo e-mail e recusada", (await fails(`INSERT INTO automation_enrollments (user_id, automation_id, email, cohort) VALUES ($1,$2,'ivo@x.com','treatment')`, [A, AUTO_A]))?.includes("unique") || false);
eq("upsert ON CONFLICT DO NOTHING devolve 0 linhas (e como o codigo detecta 'ja inscrito')", (await rows(`INSERT INTO automation_enrollments (user_id, automation_id, email, cohort) VALUES ($1,$2,'ivo@x.com','control') ON CONFLICT (automation_id, email) DO NOTHING RETURNING id`, [A, AUTO_A])).length, 0);
ok("e-mail em maiuscula na inscricao e recusado", (await fails(`INSERT INTO automation_enrollments (user_id, automation_id, email, cohort) VALUES ($1,$2,'Ana@X.com','treatment')`, [A, AUTO_A]))?.includes("check"));
ok("coorte invalida e recusada", (await fails(`INSERT INTO automation_enrollments (user_id, automation_id, email, cohort) VALUES ($1,$2,'ana@x.com','teste')`, [A, AUTO_A]))?.includes("check"));
ok("apagar a automacao apaga as inscricoes (CASCADE)", await (async () => {
  await db.query(`INSERT INTO automations (id, user_id, name, trigger_type) VALUES ('00000000-0000-0000-0000-0000000000a9', $1, 'tmp', 'recency_reached')`, [A]);
  await db.query(`INSERT INTO automation_enrollments (user_id, automation_id, email, cohort) VALUES ($1,'00000000-0000-0000-0000-0000000000a9','tmp@x.com','treatment')`, [A]);
  await db.query(`DELETE FROM automations WHERE id='00000000-0000-0000-0000-0000000000a9'`);
  return (await rows(`SELECT 1 FROM automation_enrollments WHERE email='tmp@x.com'`)).length === 0;
})());

console.log("\n[054] regua_report (tratamento x controle, janela 7 dias)");
await db.exec(`DELETE FROM automation_enrollments WHERE automation_id='${AUTO_A}'`);
const ins = (n, email, cohort, daysAgo) => db.query(
  `INSERT INTO automation_enrollments (user_id, automation_id, contact_id, email, cohort, enrolled_at) VALUES ($1,$2,$3,$4,$5, now() - make_interval(days => $6))`,
  [A, AUTO_A, cid(n), email, cohort, daysAgo]);
await ins(1, "ana@x.com", "treatment", 10);    // compra dentro da janela
await ins(2, "bia@x.com", "treatment", 10);    // so tem pedido ANTES e pedido nao pago
await ins(4, "cris@x.com", "control", 10);     // compra casada so por e-mail (maiuscula)
await ins(5, "dani@x.com", "control", 2);      // janela ainda aberta (nao maduro)
const ord = (contact, email, status, total, daysFromEnroll, enrollDaysAgo, ext) => db.query(
  `INSERT INTO orders (user_id, contact_id, external_order_id, platform, status, total_amount, customer_email, ordered_at)
   VALUES ($1,$2,$3,'woocommerce',$4,$5,$6, now() - make_interval(days => $7) + make_interval(days => $8))`,
  [A, contact, ext, status, total, email, enrollDaysAgo, daysFromEnroll]);
await ord(cid(1), "ana@x.com", "wc-enviado", 150, 3, 10, "o1");     // conta
await ord(cid(1), "ana@x.com", "completed", 70, 9, 10, "o2");        // fora da janela de 7 dias
await ord(cid(2), "bia@x.com", "wc-completed", 99, -5, 10, "o3");    // antes da inscricao
await ord(cid(2), "bia@x.com", "pending", 60, 2, 10, "o4");          // nao pago
await ord(null, "CRIS@x.com", "completed", 80, 4, 10, "o5");         // controle, so por e-mail
await ord(cid(5), "dani@x.com", "wc-processing", 40, 1, 2, "o6");    // controle ainda aberto, conta
const rep = Object.fromEntries((await rows(`SELECT * FROM regua_report($1, 7)`, [AUTO_A])).map((r) => [r.cohort, { enrolled: Number(r.enrolled), matured: Number(r.matured), converted: Number(r.converted), orders: Number(r.orders_count), revenue: Number(r.revenue) }]));
eq("tratamento: 2 inscritos, 1 comprou, 1 pedido, R$ 150 (so o pago dentro da janela)", rep.treatment, { enrolled: 2, matured: 2, converted: 1, orders: 1, revenue: 150 });
eq("controle: 2 inscritos, 1 maduro, 2 compraram, R$ 120 (e-mail casa sem diferenciar maiusculas)", rep.control, { enrolled: 2, matured: 1, converted: 2, orders: 2, revenue: 120 });
eq("janela maior (30 dias) passa a contar o pedido do dia +9", Number((await rows(`SELECT sum(revenue) AS r FROM regua_report($1, 30) WHERE cohort='treatment'`, [AUTO_A]))[0].r), 220);
eq("relatorio de automacao sem inscritos e vazio", (await rows(`SELECT * FROM regua_report($1, 7)`, [AUTO_B])).length, 0);
await db.query(`INSERT INTO orders (user_id, contact_id, external_order_id, platform, status, total_amount, customer_email, ordered_at) VALUES ($1,null,'o7','woocommerce','completed',500,'ana@x.com', now())`, [B]);
eq("isolamento: pedido de outro cliente com o mesmo e-mail NAO entra no relatorio", Number((await rows(`SELECT sum(revenue) AS r FROM regua_report($1, 30) WHERE cohort='treatment'`, [AUTO_A]))[0].r), 220);

console.log("\n[054] permissoes e RLS");
const fp = async (role, sig) => (await rows(`SELECT has_function_privilege('${role}', '${sig}', 'EXECUTE') AS p`))[0].p;
for (const sig of ["recency_candidates(uuid,uuid,int,int,int)", "recency_candidates_count(uuid,uuid,int,int)", "regua_report(uuid,int)"]) {
  ok(`${sig}: anon e authenticated NAO executam`, !(await fp("anon", sig)) && !(await fp("authenticated", sig)));
  ok(`${sig}: service_role executa`, await fp("service_role", sig));
}
await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${A}', false);`);
eq("RLS: usuario A ve as proprias inscricoes", (await rows(`SELECT email FROM automation_enrollments ORDER BY email`)).map((r) => r.email), ["ana@x.com", "bia@x.com", "cris@x.com", "dani@x.com"]);
ok("RLS: usuario A nao consegue INSERIR inscricoes (so o servico escreve)", (await fails(`INSERT INTO automation_enrollments (user_id, automation_id, email, cohort) VALUES ('${A}','${AUTO_A}','novo@x.com','treatment')`)) !== null);
ok("RLS: usuario A nao consegue chamar recency_candidates", (await fails(`SELECT * FROM recency_candidates('${B}','${AUTO_B}',1,9999,10)`))?.includes("permission denied") || false);
eq("RLS: usuario A nao ve email_messages (vazio)", (await rows(`SELECT 1 FROM email_messages`)).length, 0);
await db.exec(`RESET ROLE; INSERT INTO email_messages (user_id,to_email,subject,category,status) VALUES ('${B}','x@x.com','s','marketing','sent');`);
await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${A}', false);`);
eq("RLS: ... mesmo existindo uma linha do B", (await rows(`SELECT 1 FROM email_messages`)).length, 0);
ok("RLS: A nao consegue gravar supressao em nome do B", (await fails(`INSERT INTO email_suppressions (user_id,email,reason) VALUES ('${B}','v@x.com','manual')`)) !== null);
ok("RLS: A consegue gerir a propria supressao", (await fails(`INSERT INTO email_suppressions (user_id,email,reason) VALUES ('${A}','meu@x.com','manual')`)) === null);
await db.exec(`SET ROLE service_role`);
// Ana, Bia, Cris e Dani ja estao inscritas a esta altura (teste do relatorio): sobram Gil, Hugo e Ivo.
eq("service_role executa as funcoes", (await rows(`SELECT contact_email FROM recency_candidates('${A}','${AUTO_A}',90,364,100)`)).map((r) => r.contact_email), ["gil@x.com", "hugo@x.com", "ivo@x.com"]);
await db.exec(`RESET ROLE`);

console.log("\n[055] carrinhos abandonados");
await db.exec(`
  INSERT INTO abandoned_carts (user_id, external_id, email, status, items, total, sequence_started_at)
  VALUES ('${A}', '41', 'maria@x.com', 'abandoned', '[{"name":"Calcinha","quantity":2}]', 79.80, now());
`);
eq("grava um carrinho", (await rows(`SELECT external_id, status, total::text AS total, currency FROM abandoned_carts WHERE user_id='${A}'`)), [{ external_id: "41", status: "abandoned", total: "79.80", currency: "BRL" }]);
ok("o mesmo carrinho do plugin nao entra duas vezes (UNIQUE user_id, external_id)", !!(await fails(`INSERT INTO abandoned_carts (user_id, external_id, email) VALUES ('${A}', '41', 'maria@x.com')`)));
ok("outro cliente (tenant) pode ter o mesmo id de carrinho", !(await fails(`INSERT INTO abandoned_carts (user_id, external_id, email) VALUES ('${B}', '41', 'maria@x.com')`)));
ok("status invalido e recusado", !!(await fails(`INSERT INTO abandoned_carts (user_id, external_id, email, status) VALUES ('${A}', '42', 'a@x.com', 'wat')`)));
ok("e-mail precisa estar normalizado (minusculo, sem espacos)", !!(await fails(`INSERT INTO abandoned_carts (user_id, external_id, email) VALUES ('${A}', '43', ' Maria@X.com ')`)));
ok("carrinho so com telefone (e-mail nulo) e aceito", !(await fails(`INSERT INTO abandoned_carts (user_id, external_id, phone) VALUES ('${A}', '44', '5547991110099')`)));
eq("UPSERT por (user_id, external_id) atualiza sem duplicar nem apagar a data de inicio da sequencia", await (async () => {
  await db.exec(`INSERT INTO abandoned_carts (user_id, external_id, email, status, total) VALUES ('${A}', '41', 'maria@x.com', 'converted', 99) ON CONFLICT (user_id, external_id) DO UPDATE SET status = EXCLUDED.status, total = EXCLUDED.total`);
  return rows(`SELECT status, total::text AS total, (sequence_started_at IS NOT NULL) AS started FROM abandoned_carts WHERE user_id='${A}' AND external_id='41'`);
})(), [{ status: "converted", total: "99.00", started: true }]);
await db.exec(`SET ROLE authenticated`);
ok("usuario autenticado nao grava (so o service role escreve)", !!(await fails(`INSERT INTO abandoned_carts (user_id, external_id, email) VALUES ('${A}', '45', 'z@x.com')`)));
await db.exec(`RESET ROLE`);
ok("RLS ligada em abandoned_carts", (await rows(`SELECT relrowsecurity FROM pg_class WHERE relname='abandoned_carts'`))[0].relrowsecurity === true);

console.log("\n[054] desempenho (dados sinteticos, PGlite/WASM: so para ver se o plano nao explode)");
await db.exec(`
  INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000f1','big@t.co');
  INSERT INTO automations (id, user_id, name, trigger_type) VALUES ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000f1','big','recency_reached');
  INSERT INTO contacts (id, user_id, phone, name, email)
    SELECT gen_random_uuid(), '00000000-0000-0000-0000-0000000000f1', '55479' || lpad(g::text, 8, '0'), 'P' || g, 'p' || g || '@big.com' FROM generate_series(1, 20000) g;
  INSERT INTO contact_rfm_metrics (contact_id, user_id, recency_days)
    SELECT id, user_id, 60 + (row_number() OVER ())::int % 700 FROM contacts WHERE user_id='00000000-0000-0000-0000-0000000000f1';
  INSERT INTO orders (user_id, contact_id, external_order_id, platform, status, total_amount, customer_email, ordered_at)
    SELECT c.user_id, c.id, 'big' || row_number() OVER (), 'woocommerce', 'wc-enviado', 150, c.email,
           now() - CASE WHEN row_number() OVER () <= 8000 THEN interval '30 days' ELSE interval '200 days' END
    FROM contacts c WHERE c.user_id='00000000-0000-0000-0000-0000000000f1';
  INSERT INTO automation_enrollments (user_id, automation_id, contact_id, email, cohort, enrolled_at)
    SELECT c.user_id, '00000000-0000-0000-0000-0000000000f2', c.id, lower(c.email), 'treatment', now() - interval '45 days'
    FROM contacts c WHERE c.user_id='00000000-0000-0000-0000-0000000000f1' LIMIT 8000;
`);
const t = async (label, sql) => { const s = Date.now(); const r = await rows(sql); console.log(`   ${label}: ${Date.now() - s} ms (${r.length} linhas)`); return Date.now() - s; };
const t1 = await t("recency_candidates (limite 100)", `SELECT * FROM recency_candidates('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000f2',90,364,100)`);
const t2 = await t("recency_candidates_count", `SELECT recency_candidates_count('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000f2',90,364)`);
const t3 = await t("regua_report (8.000 inscritos x 20.000 pedidos)", `SELECT * FROM regua_report('00000000-0000-0000-0000-0000000000f2', 60)`);
ok("funcoes respondem em tempo razoavel neste volume (< 20 s cada, no WASM)", Math.max(t1, t2, t3) < 20000, `${t1}/${t2}/${t3} ms`);

console.log(`\nRESULTADO: ${pass} ok, ${fail} falhas`);
await db.close();
process.exit(fail ? 1 : 0);
