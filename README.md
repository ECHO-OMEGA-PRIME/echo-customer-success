# Echo Customer Success

> AI-powered customer health & retention platform for ECHO Prime (v1.0.0). Track
> account health signals, fire risk/expansion alerts, run playbooks and
> onboarding, log touchpoints, and gather survey feedback — a Cloudflare Worker on
> D1 + KV.

Private to Echo Prime Technologies.

## Model

**Organizations** own **accounts** managed by **CSM users**. Health **signals**
roll up into account health and fire **alerts**; **playbooks** drive the response.
**Onboarding** (from templates), **touchpoints**, and **surveys** track the
relationship, and **expansions** capture upsell opportunities.

## API (auth: `X-Echo-API-Key`)

| Route | Resource |
|---|---|
| `/` , `/health` | Service info / liveness |
| `/orgs` | Organizations |
| `/accounts` | Customer accounts (+ health) |
| `/csm-users` | Customer-success managers |
| `/signals` | Health signals |
| `/alerts` | Risk / expansion alerts |
| `/playbooks` | Success playbooks |
| `/touchpoints` | Logged interactions |
| `/onboarding/templates` | Onboarding templates |
| `/surveys` | NPS / CSAT surveys |
| `/expansions` | Upsell / expansion opportunities |

Each resource path responds to `GET` (list/read) and `POST` (create), plus
`PUT`/`DELETE` on `/:id` where applicable. Requests are rate-limited via KV.

## Develop

```bash
npm install
npx wrangler dev       # local Worker
npx wrangler deploy    # deploy
```

`DB` (D1), `CS_CACHE` (KV), and service bindings (`ENGINE_RUNTIME`,
`SHARED_BRAIN`, `EMAIL_SENDER`) are declared in `wrangler.toml`. Never commit secrets.

## License

Proprietary — © Echo Prime Technologies. All rights reserved.
