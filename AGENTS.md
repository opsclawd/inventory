## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/` at the repo root), plus the authoritative root specifications:
- `ARCHITECTURE.md` at the repo root (Multi-Tenant DDD Modular Monolith across `shared-ops`, `dismantling`, `marketplace`, `logistics-vault`, `cannabis-compliance`, and `cfo-subledger`, Prisma `multiSchema` [`shared`, `salvage`, `cannabis`], orthogonal state axes, and raw SQL/RLS constraints).
- `PRD.md` at the repo root (Phased functional requirements `FR-*`, 7-role RBAC matrix, Organization Workspace Switcher, and Phase 1A/1B/2A/2B/3 scope).
- `DOMAIN-RULES.md` at the repo root (Configurable pricing/tariff rules, LHD vs. RHD compatibility, Kemptville site zoning `RULE-ZONE-001`, cannabis mass-balance `RULE-CAN-001`, and compliance gates).
- `README.md` at the repo root (Dual-engine architecture overview, schema isolation summary, and phased delivery roadmap).

See `docs/agents/domain.md`.
