// Echo Customer Success v1.0.0 — AI-Powered Customer Health & Retention
// Cloudflare Worker: D1 + KV + Service Bindings

interface Env { DB: D1Database; CS_CACHE: KVNamespace; ENGINE_RUNTIME: Fetcher; SHARED_BRAIN: Fetcher; EMAIL_SENDER: Fetcher; ECHO_API_KEY: string; }
interface RLState { c: number; t: number }

function sanitize(s: unknown, max = 500): string { if (typeof s !== 'string') return ''; return s.replace(/[\x00-\x1f]/g, '').slice(0, max); }
function jsonOk(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }); }
function jsonErr(msg: string, status = 400) { return jsonOk({ ok: false, error: msg }, status); }
function authOk(req: Request, env: Env): boolean { const k = req.headers.get('X-Echo-API-Key') || req.headers.get('Authorization')?.replace('Bearer ', '') || ''; return k === env.ECHO_API_KEY; }
async function rateLimit(kv: KVNamespace, key: string, max: number, windowMs: number): Promise<boolean> { const raw = await kv.get(key); const now = Date.now(); if (!raw) { await kv.put(key, JSON.stringify({ c: 1, t: now }), { expirationTtl: Math.ceil(windowMs / 1000) + 60 }); return true; } const s: RLState = JSON.parse(raw); const decay = (now - s.t) / windowMs; const count = Math.max(0, s.c * (1 - decay)) + 1; await kv.put(key, JSON.stringify({ c: count, t: now }), { expirationTtl: Math.ceil(windowMs / 1000) + 60 }); return count <= max; }
function ipAddr(req: Request): string { return req.headers.get('CF-Connecting-IP') || 'unknown'; }
function now(): string { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
function today(): string { return new Date().toISOString().slice(0, 10); }

function log(level: string, message: string, meta: Record<string, any> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, worker: 'echo-customer-success', message, ...meta }));
}

function calcHealthScore(signals: Record<string, unknown>[], weights: Record<string, number>): number {
  const categoryScores: Record<string, { total: number; count: number }> = {};
  for (const s of signals) {
    const cat = s.category as string;
    if (!categoryScores[cat]) categoryScores[cat] = { total: 0, count: 0 };
    categoryScores[cat].total += Number(s.value) * Number(s.weight || 1);
    categoryScores[cat].count += Number(s.weight || 1);
  }
  let weighted = 0; let totalWeight = 0;
  for (const [cat, w] of Object.entries(weights)) {
    if (categoryScores[cat]) {
      const avg = categoryScores[cat].total / categoryScores[cat].count;
      weighted += avg * w;
      totalWeight += w;
    }
  }
  return totalWeight > 0 ? Math.round(Math.min(100, Math.max(0, weighted / totalWeight))) : 50;
}


// Security headers
const SEC_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};
function withSecHeaders(res: Response): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SEC_HEADERS)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Echo-API-Key,Authorization' } });
    const url = new URL(req.url); const p = url.pathname; const m = req.method;

    if (p === '/health' || p === '/') { log('info', 'Health check', { path: p, ip: ipAddr(req) }); return jsonOk({ ok: true, service: 'echo-customer-success', version: '1.1.0', timestamp: now() }); }
    if (m === 'GET' && !(await rateLimit(env.CS_CACHE, `rl:${ipAddr(req)}`, 60, 60000))) { log('warn', 'Rate limited (read)', { path: p, ip: ipAddr(req) }); return jsonErr('Rate limited', 429); }
    if (m !== 'GET') { if (!authOk(req, env)) { log('warn', 'Auth failure', { path: p, method: m, ip: ipAddr(req) }); return jsonErr('Unauthorized', 401); } if (!(await rateLimit(env.CS_CACHE, `rl:w:${ipAddr(req)}`, 30, 60000))) { log('warn', 'Rate limited (write)', { path: p, ip: ipAddr(req) }); return jsonErr('Rate limited', 429); } }

    const db = env.DB;
    let body: Record<string, unknown> = {};
    if (m === 'POST' || m === 'PUT') { try { body = await req.json() as Record<string, unknown>; } catch { log('error', 'Invalid JSON body', { path: p, ip: ipAddr(req) }); return jsonErr('Invalid JSON'); } }

    // ── Organizations ──
    if (p === '/orgs' && m === 'GET') { return jsonOk({ ok: true, organizations: (await db.prepare('SELECT * FROM organizations WHERE status=?').bind('active').all()).results }); }
    if (p === '/orgs' && m === 'POST') {
      const name = sanitize(body.name); const slug = sanitize(body.slug, 100);
      if (!name || !slug) return jsonErr('name, slug required');
      await db.prepare('INSERT INTO organizations (name,slug,health_weights,risk_threshold,expansion_threshold) VALUES (?,?,?,?,?)').bind(name, slug, JSON.stringify(body.health_weights || { usage: 30, engagement: 25, support: 20, nps: 15, payment: 10 }), Number(body.risk_threshold) || 40, Number(body.expansion_threshold) || 80).run();
      return jsonOk({ ok: true, message: 'Organization created' }, 201);
    }
    const orgMatch = p.match(/^\/orgs\/(\d+)$/);
    if (orgMatch && m === 'PUT') {
      const id = Number(orgMatch[1]); const fields: string[] = []; const vals: unknown[] = [];
      for (const k of ['name', 'risk_threshold', 'expansion_threshold']) { if (body[k] !== undefined) { fields.push(`${k}=?`); vals.push(typeof body[k] === 'string' ? sanitize(body[k] as string) : body[k]); } }
      if (body.health_weights) { fields.push('health_weights=?'); vals.push(JSON.stringify(body.health_weights)); }
      if (!fields.length) return jsonErr('No fields'); fields.push('updated_at=?'); vals.push(now()); vals.push(id);
      await db.prepare(`UPDATE organizations SET ${fields.join(',')} WHERE id=?`).bind(...vals).run();
      return jsonOk({ ok: true, message: 'Updated' });
    }

    // ── CSM Users ──
    if (p === '/csm-users' && m === 'GET') { const orgId = url.searchParams.get('org_id'); const rows = orgId ? await db.prepare('SELECT * FROM csm_users WHERE org_id=?').bind(Number(orgId)).all() : await db.prepare('SELECT * FROM csm_users').all(); return jsonOk({ ok: true, users: rows.results }); }
    if (p === '/csm-users' && m === 'POST') { await db.prepare('INSERT INTO csm_users (org_id,name,email,role) VALUES (?,?,?,?)').bind(Number(body.org_id), sanitize(body.name), sanitize(body.email, 255), sanitize(body.role as string) || 'csm').run(); return jsonOk({ ok: true, message: 'CSM user created' }, 201); }

    // ── Accounts ──
    if (p === '/accounts' && m === 'GET') {
      const orgId = url.searchParams.get('org_id'); const risk = url.searchParams.get('risk_level'); const csmId = url.searchParams.get('csm_id');
      let q = 'SELECT a.*,u.name as csm_name FROM accounts a LEFT JOIN csm_users u ON a.csm_id=u.id'; const conds: string[] = []; const binds: unknown[] = [];
      if (orgId) { conds.push('a.org_id=?'); binds.push(Number(orgId)); }
      if (risk) { conds.push('a.risk_level=?'); binds.push(risk); }
      if (csmId) { conds.push('a.csm_id=?'); binds.push(Number(csmId)); }
      if (conds.length) q += ' WHERE ' + conds.join(' AND ');
      q += ' ORDER BY a.health_score ASC LIMIT 200';
      return jsonOk({ ok: true, accounts: (await db.prepare(q).bind(...binds).all()).results });
    }
    if (p === '/accounts' && m === 'POST') {
      const { org_id, name: aname } = body; if (!org_id || !aname) return jsonErr('org_id, name required');
      await db.prepare('INSERT INTO accounts (org_id,name,domain,industry,plan,mrr,arr,contract_start,contract_end,csm_id,tags,metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(
        Number(org_id), sanitize(aname), sanitize(body.domain as string, 255) || null, sanitize(body.industry as string) || null,
        sanitize(body.plan as string) || null, Number(body.mrr) || 0, Number(body.arr) || 0,
        sanitize(body.contract_start as string) || null, sanitize(body.contract_end as string) || null,
        body.csm_id ? Number(body.csm_id) : null, JSON.stringify(body.tags || []), JSON.stringify(body.metadata || {})
      ).run();
      return jsonOk({ ok: true, message: 'Account created' }, 201);
    }
    const acctMatch = p.match(/^\/accounts\/(\d+)$/);
    if (acctMatch && m === 'GET') {
      const acct = await db.prepare('SELECT a.*,u.name as csm_name FROM accounts a LEFT JOIN csm_users u ON a.csm_id=u.id WHERE a.id=?').bind(Number(acctMatch[1])).first();
      if (!acct) return jsonErr('Not found', 404);
      const [signals, touchpoints, surveys, expansions, alerts, onboarding] = await Promise.all([
        db.prepare('SELECT * FROM health_signals WHERE account_id=? ORDER BY recorded_at DESC LIMIT 20').bind(acct.id).all(),
        db.prepare('SELECT * FROM touchpoints WHERE account_id=? ORDER BY created_at DESC LIMIT 10').bind(acct.id).all(),
        db.prepare('SELECT * FROM surveys WHERE account_id=? ORDER BY created_at DESC LIMIT 10').bind(acct.id).all(),
        db.prepare('SELECT * FROM expansion_opportunities WHERE account_id=? ORDER BY created_at DESC').bind(acct.id).all(),
        db.prepare('SELECT * FROM risk_alerts WHERE account_id=? AND resolved=0 ORDER BY created_at DESC').bind(acct.id).all(),
        db.prepare('SELECT * FROM onboarding_progress WHERE account_id=? ORDER BY step_index').bind(acct.id).all(),
      ]);
      return jsonOk({ ok: true, account: acct, signals: signals.results, touchpoints: touchpoints.results, surveys: surveys.results, expansions: expansions.results, alerts: alerts.results, onboarding: onboarding.results });
    }
    if (acctMatch && m === 'PUT') {
      const id = Number(acctMatch[1]); const fields: string[] = []; const vals: unknown[] = [];
      for (const k of ['name', 'domain', 'industry', 'plan', 'mrr', 'arr', 'contract_start', 'contract_end', 'csm_id', 'status']) {
        if (body[k] !== undefined) { fields.push(`${k}=?`); vals.push(typeof body[k] === 'string' ? sanitize(body[k] as string) : body[k]); }
      }
      if (body.tags) { fields.push('tags=?'); vals.push(JSON.stringify(body.tags)); }
      if (!fields.length) return jsonErr('No fields'); fields.push('updated_at=?'); vals.push(now()); vals.push(id);
      await db.prepare(`UPDATE accounts SET ${fields.join(',')} WHERE id=?`).bind(...vals).run();
      return jsonOk({ ok: true, message: 'Account updated' });
    }

    // ── Health Signals ──
    if (p === '/signals' && m === 'POST') {
      const { account_id, org_id, signal_type, category, value } = body;
      if (!account_id || !org_id || !signal_type || !category || value === undefined) return jsonErr('account_id, org_id, signal_type, category, value required');
      await db.prepare('INSERT INTO health_signals (account_id,org_id,signal_type,category,value,weight,details) VALUES (?,?,?,?,?,?,?)').bind(
        Number(account_id), Number(org_id), sanitize(signal_type), sanitize(category), Number(value), Number(body.weight) || 1, sanitize(body.details as string, 1000) || null
      ).run();
      // Recalculate health score
      const org = await db.prepare('SELECT health_weights,risk_threshold,expansion_threshold FROM organizations WHERE id=?').bind(Number(org_id)).first();
      const weights = org ? JSON.parse(org.health_weights as string) : { usage: 30, engagement: 25, support: 20, nps: 15, payment: 10 };
      const recentSignals = await db.prepare("SELECT * FROM health_signals WHERE account_id=? AND recorded_at>=datetime('now','-30 days')").bind(Number(account_id)).all();
      const score = calcHealthScore(recentSignals.results as Record<string, unknown>[], weights);
      const riskThreshold = Number(org?.risk_threshold) || 40;
      const expansionThreshold = Number(org?.expansion_threshold) || 80;
      const riskLevel = score < riskThreshold ? 'high' : score < 60 ? 'medium' : 'low';
      const expansionPotential = score >= expansionThreshold ? 'high' : score >= 60 ? 'medium' : 'none';
      // Detect trend
      const olderSignals = await db.prepare("SELECT * FROM health_signals WHERE account_id=? AND recorded_at>=datetime('now','-60 days') AND recorded_at<datetime('now','-30 days')").bind(Number(account_id)).all();
      const oldScore = olderSignals.results.length > 0 ? calcHealthScore(olderSignals.results as Record<string, unknown>[], weights) : score;
      const trend = score > oldScore + 5 ? 'improving' : score < oldScore - 5 ? 'declining' : 'stable';
      await db.prepare('UPDATE accounts SET health_score=?,health_trend=?,risk_level=?,expansion_potential=?,last_activity=?,updated_at=? WHERE id=?').bind(score, trend, riskLevel, expansionPotential, now(), now(), Number(account_id)).run();
      // Auto-create risk alert if score dropped below threshold
      if (score < riskThreshold && oldScore >= riskThreshold) {
        await db.prepare('INSERT INTO risk_alerts (account_id,org_id,alert_type,severity,description,recommended_action) VALUES (?,?,?,?,?,?)').bind(
          Number(account_id), Number(org_id), 'health_drop', 'high', `Health score dropped to ${score} (was ${oldScore})`, 'Schedule immediate check-in call'
        ).run();
      }
      return jsonOk({ ok: true, health_score: score, risk_level: riskLevel, trend }, 201);
    }

    // ── Onboarding Templates ──
    if (p === '/onboarding/templates' && m === 'GET') {
      const orgId = url.searchParams.get('org_id');
      const rows = orgId ? await db.prepare('SELECT * FROM onboarding_templates WHERE org_id=? AND status=?').bind(Number(orgId), 'active').all() : await db.prepare('SELECT * FROM onboarding_templates WHERE status=?').bind('active').all();
      return jsonOk({ ok: true, templates: rows.results });
    }
    if (p === '/onboarding/templates' && m === 'POST') {
      if (!body.org_id || !body.name || !body.steps) return jsonErr('org_id, name, steps required');
      await db.prepare('INSERT INTO onboarding_templates (org_id,name,steps,target_days) VALUES (?,?,?,?)').bind(Number(body.org_id), sanitize(body.name), JSON.stringify(body.steps), Number(body.target_days) || 30).run();
      return jsonOk({ ok: true, message: 'Template created' }, 201);
    }
    // Start onboarding for an account
    const startOnboard = p.match(/^\/onboarding\/start$/);
    if (startOnboard && m === 'POST') {
      const { account_id, template_id } = body;
      if (!account_id || !template_id) return jsonErr('account_id, template_id required');
      const tmpl = await db.prepare('SELECT * FROM onboarding_templates WHERE id=?').bind(Number(template_id)).first();
      if (!tmpl) return jsonErr('Template not found', 404);
      const steps = JSON.parse(tmpl.steps as string) as string[];
      const stmts = steps.map((step: string, i: number) => db.prepare('INSERT INTO onboarding_progress (account_id,template_id,step_index,step_name) VALUES (?,?,?,?)').bind(Number(account_id), Number(template_id), i, step));
      await db.batch(stmts);
      return jsonOk({ ok: true, message: 'Onboarding started', steps: steps.length });
    }
    // Complete onboarding step
    const completeStep = p.match(/^\/onboarding\/complete-step$/);
    if (completeStep && m === 'POST') {
      const { account_id, step_index, notes } = body;
      await db.prepare('UPDATE onboarding_progress SET completed=1,completed_at=?,notes=? WHERE account_id=? AND step_index=?').bind(now(), sanitize(notes as string, 1000) || null, Number(account_id), Number(step_index)).run();
      // Check if all steps complete
      const remaining = await db.prepare('SELECT COUNT(*) as c FROM onboarding_progress WHERE account_id=? AND completed=0').bind(Number(account_id)).first();
      if (remaining && (remaining.c as number) === 0) {
        await db.prepare('UPDATE accounts SET onboarding_complete=1,updated_at=? WHERE id=?').bind(now(), Number(account_id)).run();
      }
      return jsonOk({ ok: true, message: 'Step completed', remaining: remaining?.c || 0 });
    }

    // ── Playbooks ──
    if (p === '/playbooks' && m === 'GET') {
      const orgId = url.searchParams.get('org_id');
      const rows = orgId ? await db.prepare('SELECT * FROM playbooks WHERE org_id=? AND status=?').bind(Number(orgId), 'active').all() : await db.prepare('SELECT * FROM playbooks WHERE status=?').bind('active').all();
      return jsonOk({ ok: true, playbooks: rows.results });
    }
    if (p === '/playbooks' && m === 'POST') {
      if (!body.org_id || !body.name || !body.trigger_type) return jsonErr('org_id, name, trigger_type required');
      await db.prepare('INSERT INTO playbooks (org_id,name,trigger_type,trigger_conditions,actions,is_automated) VALUES (?,?,?,?,?,?)').bind(
        Number(body.org_id), sanitize(body.name), sanitize(body.trigger_type), JSON.stringify(body.trigger_conditions || {}),
        JSON.stringify(body.actions || []), body.is_automated ? 1 : 0
      ).run();
      return jsonOk({ ok: true, message: 'Playbook created' }, 201);
    }
    // Execute playbook
    const execPlaybook = p.match(/^\/playbooks\/(\d+)\/execute$/);
    if (execPlaybook && m === 'POST') {
      const pbId = Number(execPlaybook[1]); const accountId = Number(body.account_id);
      if (!accountId) return jsonErr('account_id required');
      await db.prepare('INSERT INTO playbook_executions (playbook_id,account_id,triggered_by) VALUES (?,?,?)').bind(pbId, accountId, sanitize(body.triggered_by as string) || 'manual').run();
      return jsonOk({ ok: true, message: 'Playbook execution started' }, 201);
    }

    // ── Touchpoints ──
    if (p === '/touchpoints' && m === 'GET') {
      const accountId = url.searchParams.get('account_id'); const orgId = url.searchParams.get('org_id');
      let q = 'SELECT t.*,u.name as csm_name FROM touchpoints t LEFT JOIN csm_users u ON t.csm_id=u.id'; const conds: string[] = []; const binds: unknown[] = [];
      if (accountId) { conds.push('t.account_id=?'); binds.push(Number(accountId)); }
      if (orgId) { conds.push('t.org_id=?'); binds.push(Number(orgId)); }
      if (conds.length) q += ' WHERE ' + conds.join(' AND ');
      q += ' ORDER BY t.created_at DESC LIMIT 50';
      return jsonOk({ ok: true, touchpoints: (await db.prepare(q).bind(...binds).all()).results });
    }
    if (p === '/touchpoints' && m === 'POST') {
      if (!body.account_id || !body.org_id || !body.type) return jsonErr('account_id, org_id, type required');
      await db.prepare('INSERT INTO touchpoints (account_id,org_id,csm_id,type,subject,notes,sentiment,next_action,next_action_date) VALUES (?,?,?,?,?,?,?,?,?)').bind(
        Number(body.account_id), Number(body.org_id), body.csm_id ? Number(body.csm_id) : null, sanitize(body.type),
        sanitize(body.subject as string) || null, sanitize(body.notes as string, 2000) || null, sanitize(body.sentiment as string) || 'neutral',
        sanitize(body.next_action as string, 1000) || null, sanitize(body.next_action_date as string) || null
      ).run();
      await db.prepare('UPDATE accounts SET last_activity=?,updated_at=? WHERE id=?').bind(now(), now(), Number(body.account_id)).run();
      return jsonOk({ ok: true, message: 'Touchpoint logged' }, 201);
    }

    // ── Surveys (NPS/CSAT) ──
    if (p === '/surveys' && m === 'POST') {
      if (!body.account_id || !body.org_id || !body.survey_type) return jsonErr('account_id, org_id, survey_type required');
      await db.prepare('INSERT INTO surveys (account_id,org_id,survey_type,score,feedback,respondent_name,respondent_email) VALUES (?,?,?,?,?,?,?)').bind(
        Number(body.account_id), Number(body.org_id), sanitize(body.survey_type), body.score !== undefined ? Number(body.score) : null,
        sanitize(body.feedback as string, 2000) || null, sanitize(body.respondent_name as string) || null, sanitize(body.respondent_email as string, 255) || null
      ).run();
      // Update account NPS/CSAT
      if (body.survey_type === 'nps' && body.score !== undefined) { await db.prepare('UPDATE accounts SET nps_score=?,updated_at=? WHERE id=?').bind(Number(body.score), now(), Number(body.account_id)).run(); }
      if (body.survey_type === 'csat' && body.score !== undefined) { await db.prepare('UPDATE accounts SET csat_score=?,updated_at=? WHERE id=?').bind(Number(body.score), now(), Number(body.account_id)).run(); }
      return jsonOk({ ok: true, message: 'Survey response recorded' }, 201);
    }

    // ── Expansion Opportunities ──
    if (p === '/expansions' && m === 'GET') {
      const orgId = url.searchParams.get('org_id');
      const rows = orgId ? await db.prepare("SELECT e.*,a.name as account_name FROM expansion_opportunities e JOIN accounts a ON e.account_id=a.id WHERE e.org_id=? AND e.status!='closed_lost' ORDER BY e.potential_arr DESC").bind(Number(orgId)).all() : await db.prepare("SELECT e.*,a.name as account_name FROM expansion_opportunities e JOIN accounts a ON e.account_id=a.id WHERE e.status!='closed_lost' ORDER BY e.potential_arr DESC").all();
      return jsonOk({ ok: true, expansions: rows.results });
    }
    if (p === '/expansions' && m === 'POST') {
      if (!body.account_id || !body.org_id || !body.type) return jsonErr('account_id, org_id, type required');
      await db.prepare('INSERT INTO expansion_opportunities (account_id,org_id,type,description,potential_arr,confidence,csm_id) VALUES (?,?,?,?,?,?,?)').bind(
        Number(body.account_id), Number(body.org_id), sanitize(body.type), sanitize(body.description as string, 1000) || null,
        Number(body.potential_arr) || 0, Number(body.confidence) || 0.5, body.csm_id ? Number(body.csm_id) : null
      ).run();
      return jsonOk({ ok: true, message: 'Expansion opportunity created' }, 201);
    }
    const closeExpansion = p.match(/^\/expansions\/(\d+)\/(close-won|close-lost)$/);
    if (closeExpansion && m === 'POST') {
      const id = Number(closeExpansion[1]); const outcome = closeExpansion[2];
      await db.prepare('UPDATE expansion_opportunities SET status=?,closed_at=? WHERE id=?').bind(outcome === 'close-won' ? 'closed_won' : 'closed_lost', now(), id).run();
      return jsonOk({ ok: true, message: `Expansion ${outcome}` });
    }

    // ── Risk Alerts ──
    if (p === '/alerts' && m === 'GET') {
      const orgId = url.searchParams.get('org_id'); const unresolved = url.searchParams.get('unresolved');
      let q = 'SELECT r.*,a.name as account_name FROM risk_alerts r JOIN accounts a ON r.account_id=a.id';
      const conds: string[] = []; const binds: unknown[] = [];
      if (orgId) { conds.push('r.org_id=?'); binds.push(Number(orgId)); }
      if (unresolved === 'true') { conds.push('r.resolved=0'); }
      if (conds.length) q += ' WHERE ' + conds.join(' AND ');
      q += ' ORDER BY r.created_at DESC LIMIT 50';
      return jsonOk({ ok: true, alerts: (await db.prepare(q).bind(...binds).all()).results });
    }
    const ackAlert = p.match(/^\/alerts\/(\d+)\/acknowledge$/);
    if (ackAlert && m === 'POST') { await db.prepare('UPDATE risk_alerts SET acknowledged=1,acknowledged_by=? WHERE id=?').bind(Number(body.csm_id) || null, Number(ackAlert[1])).run(); return jsonOk({ ok: true, message: 'Acknowledged' }); }
    const resolveAlert = p.match(/^\/alerts\/(\d+)\/resolve$/);
    if (resolveAlert && m === 'POST') { await db.prepare('UPDATE risk_alerts SET resolved=1,resolved_at=? WHERE id=?').bind(now(), Number(resolveAlert[1])).run(); return jsonOk({ ok: true, message: 'Resolved' }); }

    // ── Dashboard ──
    const dashMatch = p.match(/^\/dashboard\/(\d+)$/);
    if (dashMatch && m === 'GET') {
      const orgId = Number(dashMatch[1]);
      const [totalAccounts, atRisk, healthy, avgHealth, totalMrr, openAlerts, pendingExpansion, recentTouchpoints] = await Promise.all([
        db.prepare("SELECT COUNT(*) as c FROM accounts WHERE org_id=? AND status='active'").bind(orgId).first(),
        db.prepare("SELECT COUNT(*) as c FROM accounts WHERE org_id=? AND risk_level='high' AND status='active'").bind(orgId).first(),
        db.prepare("SELECT COUNT(*) as c FROM accounts WHERE org_id=? AND health_score>=70 AND status='active'").bind(orgId).first(),
        db.prepare("SELECT AVG(health_score) as avg FROM accounts WHERE org_id=? AND status='active'").bind(orgId).first(),
        db.prepare("SELECT COALESCE(SUM(mrr),0) as total FROM accounts WHERE org_id=? AND status='active'").bind(orgId).first(),
        db.prepare('SELECT COUNT(*) as c FROM risk_alerts WHERE org_id=? AND resolved=0').bind(orgId).first(),
        db.prepare("SELECT COUNT(*) as c,COALESCE(SUM(potential_arr),0) as total FROM expansion_opportunities WHERE org_id=? AND status='identified'").bind(orgId).first(),
        db.prepare('SELECT t.*,a.name as account_name FROM touchpoints t JOIN accounts a ON t.account_id=a.id WHERE t.org_id=? ORDER BY t.created_at DESC LIMIT 5').bind(orgId).all(),
      ]);
      const topRisk = await db.prepare("SELECT id,name,health_score,health_trend,mrr FROM accounts WHERE org_id=? AND status='active' ORDER BY health_score ASC LIMIT 5").bind(orgId).all();
      const topExpansion = await db.prepare("SELECT id,name,health_score,expansion_potential,mrr FROM accounts WHERE org_id=? AND status='active' AND expansion_potential='high' ORDER BY mrr DESC LIMIT 5").bind(orgId).all();
      return jsonOk({ ok: true, dashboard: {
        total_accounts: totalAccounts?.c || 0, at_risk: atRisk?.c || 0, healthy: healthy?.c || 0,
        avg_health: Math.round(Number(avgHealth?.avg) || 0), total_mrr: Number(totalMrr?.total) || 0,
        open_alerts: openAlerts?.c || 0, expansion_pipeline: { count: pendingExpansion?.c || 0, potential_arr: Number(pendingExpansion?.total) || 0 },
        top_risk_accounts: topRisk.results, top_expansion_accounts: topExpansion.results, recent_touchpoints: recentTouchpoints.results
      }});
    }

    // ── AI Retention Recommendations ──
    const aiRetention = p.match(/^\/ai\/retention\/(\d+)$/);
    if (aiRetention && m === 'GET') {
      const accountId = Number(aiRetention[1]);
      const acct = await db.prepare('SELECT * FROM accounts WHERE id=?').bind(accountId).first();
      if (!acct) return jsonErr('Account not found', 404);
      const signals = await db.prepare("SELECT * FROM health_signals WHERE account_id=? ORDER BY recorded_at DESC LIMIT 20").bind(accountId).all();
      const touchpoints = await db.prepare('SELECT * FROM touchpoints WHERE account_id=? ORDER BY created_at DESC LIMIT 10').bind(accountId).all();
      try {
        const resp = await env.ENGINE_RUNTIME.fetch('https://echo-engine-runtime.bmcii1976.workers.dev/query', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ engine_category: 'business', query: `Analyze this customer account for retention risk and provide specific recommendations. Account: ${JSON.stringify(acct)}. Recent health signals: ${JSON.stringify(signals.results.slice(0, 10))}. Recent touchpoints: ${JSON.stringify(touchpoints.results.slice(0, 5))}. Provide: 1) Risk assessment, 2) Top 3 retention actions, 3) Ideal next touchpoint type and timing.` })
        });
        return jsonOk({ ok: true, account: acct, ai_recommendations: await resp.json() });
      } catch (e: any) { log('error', 'AI retention fetch failed', { accountId: accountId, error: e?.message || String(e) }); return jsonOk({ ok: true, account: acct, ai_recommendations: null }); }
    }

    // ── AI Health Score Analysis ──
    const aiHealth = p.match(/^\/ai\/health-analysis\/(\d+)$/);
    if (aiHealth && m === 'GET') {
      const orgId = Number(aiHealth[1]);
      const accounts = await db.prepare("SELECT name,health_score,health_trend,risk_level,mrr,nps_score,last_activity FROM accounts WHERE org_id=? AND status='active' ORDER BY health_score ASC LIMIT 20").bind(orgId).all();
      try {
        const resp = await env.ENGINE_RUNTIME.fetch('https://echo-engine-runtime.bmcii1976.workers.dev/query', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ engine_category: 'business', query: `Analyze this customer portfolio health and provide strategic recommendations. Accounts: ${JSON.stringify(accounts.results)}. Provide: 1) Portfolio risk assessment, 2) Accounts needing immediate attention, 3) Expansion opportunities, 4) NRR improvement strategy.` })
        });
        return jsonOk({ ok: true, accounts: accounts.results, ai_analysis: await resp.json() });
      } catch (e: any) { log('error', 'AI health analysis failed', { orgId: orgId, error: e?.message || String(e) }); return jsonOk({ ok: true, accounts: accounts.results, ai_analysis: null }); }
    }

    // ── Export ──
    const exportMatch = p.match(/^\/export\/(\d+)$/);
    if (exportMatch && m === 'GET') {
      const orgId = Number(exportMatch[1]); const format = url.searchParams.get('format') || 'json';
      const accounts = await db.prepare('SELECT a.*,u.name as csm_name FROM accounts a LEFT JOIN csm_users u ON a.csm_id=u.id WHERE a.org_id=?').bind(orgId).all();
      if (format === 'csv') {
        const headers = 'id,name,domain,plan,mrr,health_score,risk_level,expansion_potential,nps_score,csm_name,status';
        const rows = (accounts.results as Record<string, unknown>[]).map(r => `${r.id},"${r.name}","${r.domain}","${r.plan}",${r.mrr},${r.health_score},${r.risk_level},${r.expansion_potential},${r.nps_score || ''},"${r.csm_name || ''}",${r.status}`);
        return new Response(headers + '\n' + rows.join('\n'), { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=accounts.csv', 'Access-Control-Allow-Origin': '*' } });
      }
      return jsonOk({ ok: true, accounts: accounts.results });
    }

    log('warn', 'Route not found', { path: p, method: m, ip: ipAddr(req) });
    return jsonErr('Not found', 404);
  },

  async scheduled(event: ScheduledEvent, env: Env) {
    log('info', 'Scheduled job started', { cron: event.cron });
    const db = env.DB; const t = today(); const n = now();
    // Daily health snapshots per org
    const orgs = await db.prepare("SELECT id FROM organizations WHERE status='active'").all();
    for (const org of orgs.results as Record<string, unknown>[]) {
      const orgId = org.id as number;
      const [total, atRisk, healthy, avgH, mrr, expansionReady] = await Promise.all([
        db.prepare("SELECT COUNT(*) as c FROM accounts WHERE org_id=? AND status='active'").bind(orgId).first(),
        db.prepare("SELECT COUNT(*) as c FROM accounts WHERE org_id=? AND risk_level='high' AND status='active'").bind(orgId).first(),
        db.prepare("SELECT COUNT(*) as c FROM accounts WHERE org_id=? AND health_score>=70 AND status='active'").bind(orgId).first(),
        db.prepare("SELECT AVG(health_score) as avg FROM accounts WHERE org_id=? AND status='active'").bind(orgId).first(),
        db.prepare("SELECT COALESCE(SUM(mrr),0) as total FROM accounts WHERE org_id=? AND status='active'").bind(orgId).first(),
        db.prepare("SELECT COUNT(*) as c FROM accounts WHERE org_id=? AND expansion_potential='high' AND status='active'").bind(orgId).first(),
      ]);
      await db.prepare('INSERT OR REPLACE INTO health_daily (org_id,date,total_accounts,avg_health,at_risk,healthy,expansion_ready,total_mrr) VALUES (?,?,?,?,?,?,?,?)').bind(
        orgId, t, total?.c || 0, Math.round(Number(avgH?.avg) || 0), atRisk?.c || 0, healthy?.c || 0, expansionReady?.c || 0, Number(mrr?.total) || 0
      ).run();
    }
    // Auto-create alerts for accounts with no touchpoints in 30 days
    const staleAccounts = await db.prepare("SELECT a.id,a.org_id,a.name FROM accounts a WHERE a.status='active' AND a.last_activity<datetime('now','-30 days') AND a.id NOT IN (SELECT account_id FROM risk_alerts WHERE alert_type='no_contact' AND resolved=0)").all();
    for (const acct of staleAccounts.results as Record<string, unknown>[]) {
      await db.prepare('INSERT INTO risk_alerts (account_id,org_id,alert_type,severity,description,recommended_action) VALUES (?,?,?,?,?,?)').bind(
        acct.id, acct.org_id, 'no_contact', 'medium', `No touchpoints in 30+ days for ${acct.name}`, 'Schedule a check-in call or send a pulse survey'
      ).run();
    }
    // Auto-create alerts for contracts expiring in 60 days
    const expiringContracts = await db.prepare("SELECT a.id,a.org_id,a.name,a.contract_end FROM accounts a WHERE a.status='active' AND a.contract_end IS NOT NULL AND a.contract_end<=datetime('now','+60 days') AND a.contract_end>datetime('now') AND a.id NOT IN (SELECT account_id FROM risk_alerts WHERE alert_type='contract_expiring' AND resolved=0)").all();
    for (const acct of expiringContracts.results as Record<string, unknown>[]) {
      await db.prepare('INSERT INTO risk_alerts (account_id,org_id,alert_type,severity,description,recommended_action) VALUES (?,?,?,?,?,?)').bind(
        acct.id, acct.org_id, 'contract_expiring', 'high', `Contract for ${acct.name} expires ${acct.contract_end}`, 'Initiate renewal conversation immediately'
      ).run();
    }
  }
};
