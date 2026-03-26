-- Echo Customer Success v1.0.0 — AI-Powered Customer Health & Retention
-- D1 Schema

CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  health_weights JSON DEFAULT '{"usage":30,"engagement":25,"support":20,"nps":15,"payment":10}',
  risk_threshold REAL DEFAULT 40,
  expansion_threshold REAL DEFAULT 80,
  settings JSON DEFAULT '{}',
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS csm_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT DEFAULT 'csm',
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_id, email)
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  domain TEXT,
  industry TEXT,
  plan TEXT,
  mrr REAL DEFAULT 0,
  arr REAL DEFAULT 0,
  contract_start TEXT,
  contract_end TEXT,
  csm_id INTEGER,
  health_score REAL DEFAULT 50,
  health_trend TEXT DEFAULT 'stable',
  risk_level TEXT DEFAULT 'low',
  expansion_potential TEXT DEFAULT 'none',
  last_activity TEXT,
  onboarding_complete INTEGER DEFAULT 0,
  nps_score INTEGER,
  csat_score REAL,
  tags JSON DEFAULT '[]',
  metadata JSON DEFAULT '{}',
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_accounts_org ON accounts(org_id);
CREATE INDEX IF NOT EXISTS idx_accounts_csm ON accounts(csm_id);
CREATE INDEX IF NOT EXISTS idx_accounts_health ON accounts(org_id, health_score);
CREATE INDEX IF NOT EXISTS idx_accounts_risk ON accounts(org_id, risk_level);

CREATE TABLE IF NOT EXISTS health_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  signal_type TEXT NOT NULL,
  category TEXT NOT NULL,
  value REAL NOT NULL,
  weight REAL DEFAULT 1.0,
  details TEXT,
  recorded_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signals_account ON health_signals(account_id, recorded_at);

CREATE TABLE IF NOT EXISTS onboarding_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  steps JSON NOT NULL DEFAULT '[]',
  target_days INTEGER DEFAULT 30,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS onboarding_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  template_id INTEGER NOT NULL,
  step_index INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  completed INTEGER DEFAULT 0,
  completed_at TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_onboarding_account ON onboarding_progress(account_id);

CREATE TABLE IF NOT EXISTS playbooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_conditions JSON DEFAULT '{}',
  actions JSON NOT NULL DEFAULT '[]',
  is_automated INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playbook_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playbook_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  triggered_by TEXT,
  actions_completed JSON DEFAULT '[]',
  outcome TEXT,
  status TEXT DEFAULT 'in_progress',
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS touchpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  csm_id INTEGER,
  type TEXT NOT NULL,
  subject TEXT,
  notes TEXT,
  sentiment TEXT DEFAULT 'neutral',
  next_action TEXT,
  next_action_date TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_touchpoints_account ON touchpoints(account_id);

CREATE TABLE IF NOT EXISTS surveys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  survey_type TEXT NOT NULL,
  score INTEGER,
  feedback TEXT,
  respondent_name TEXT,
  respondent_email TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_surveys_account ON surveys(account_id);

CREATE TABLE IF NOT EXISTS expansion_opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  potential_arr REAL DEFAULT 0,
  confidence REAL DEFAULT 0.5,
  csm_id INTEGER,
  status TEXT DEFAULT 'identified',
  created_at TEXT DEFAULT (datetime('now')),
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_expansion_account ON expansion_opportunities(account_id);

CREATE TABLE IF NOT EXISTS risk_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  alert_type TEXT NOT NULL,
  severity TEXT DEFAULT 'medium',
  description TEXT,
  recommended_action TEXT,
  acknowledged INTEGER DEFAULT 0,
  acknowledged_by INTEGER,
  resolved INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_org ON risk_alerts(org_id, resolved);

CREATE TABLE IF NOT EXISTS health_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  total_accounts INTEGER DEFAULT 0,
  avg_health REAL DEFAULT 0,
  at_risk INTEGER DEFAULT 0,
  healthy INTEGER DEFAULT 0,
  expansion_ready INTEGER DEFAULT 0,
  total_mrr REAL DEFAULT 0,
  churned_mrr REAL DEFAULT 0,
  expanded_mrr REAL DEFAULT 0,
  nrr REAL DEFAULT 100,
  UNIQUE(org_id, date)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
