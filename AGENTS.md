## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/` at the repo root), plus the authoritative root specifications:
- `ARCHITECTURE.md` at the repo root (Multi-Tenant DDD Modular Monolith across `shared-ops`, `dismantling`, `marketplace`, `logistics-vault`, `cannabis-compliance`, and `cfo-subledger`, Prisma `multiSchema` [`shared`, `salvage`, `cannabis`], composite tenant foreign keys, orthogonal state axes, and `FORCE ROW LEVEL SECURITY` / `erp_app_user` raw SQL constraints).
- `PRD.md` at the repo root (Phased functional requirements `FR-*`, 7-role RBAC matrix, Organization Workspace Switcher, and Phase 1A/1B/2A/2B/3 scope).
- `DOMAIN-RULES.md` at the repo root (Configurable pricing/tariff rules, channel-split Ontario HST & eBay Billing Agent rules `RULE-TAX-HST-01`, eBay ship-from truth vs. classifieds masking `RULE-MKT-002`, TDG hazmat parcel blocks, multi-tenant organization & facility location isolation `RULE-ZONE-001`, post-2025 cannabis mass-balance & 3-stream destruction `RULE-CAN-001`, and compliance gates).
- `README.md` at the repo root (Multi-tenant two-entity architecture overview across Kemptville salvage and Brockville cannabis, schema isolation summary, and phased delivery roadmap).

See `docs/agents/domain.md`.

### Mandatory Database, Auth & CI Guardrails (`ADR-0005`)

- **Prisma + Supavisor Transaction-Local RLS (`erp_app_user`):** Runtime connections over Supavisor transaction pooling (`?pgbouncer=true` on port `6543`) MUST execute as `erp_app_user` (`NOBYPASSRLS`, `plan_cache_mode = force_custom_plan`) with `FORCE ROW LEVEL SECURITY` (`"organizationId" = shared.current_org_id()`, failing closed on `NULL`) and composite intra-tenant foreign keys (`@@unique([organizationId, id])`). Session-level `SET` and autocommit `set_config` are strictly banned; all repository operations MUST execute inside `withTenantTransaction(prisma, ctx, fn)` using transaction-local `set_config(..., true)`.
- **Next.js 15 / Supabase SSR Auth:** Use `@supabase/ssr` with `await supabase.auth.getUser()` (server-side `getSession()` is banned) and awaited Next.js 15 `await cookies()` / `await headers()`.
- **Real Postgres RLS Tests & No-Stub CI Gate:** Automated verification must include real PostgreSQL RLS integration tests running as `erp_app_user` and pass the no-stub composition check (`! grep -rnE "not wired|TODO.*compose" src/ app/`) banning unwired `compose.ts` stubs.
