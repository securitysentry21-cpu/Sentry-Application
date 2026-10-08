# Infrastructure

## Environments (ARCH §19.1, D-13, D-37)

| Environment | Where                                        | Database                                                    | Notes                                                      |
| ----------- | -------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| development | the developer's machine                      | embedded PostgreSQL 17 (`pnpm db:up`)                       | no Docker needed; development-only passwords               |
| test        | the developer's machine and GitHub Actions   | embedded PostgreSQL 17 locally; `postgres:17` service in CI | a fresh database per test file, connected as `app_runtime` |
| staging     | AWS cell, eu-central-1                       | RDS for PostgreSQL 17                                       | separate AWS account; SMS only to allow-listed numbers     |
| production  | AWS cell, eu-central-1, backups in eu-west-1 | RDS for PostgreSQL 17, Multi-AZ, PITR 35 days               | separate AWS account                                       |

Each cell is one deployment per data region (D-13). The `CELL_REGION` setting names it, and every organization's `data_region` must match.

## The first cell: what gets created (ARCH §19.8)

The security baseline for this cell is listed in ARCH §19.8.

- **Network:** a VPC with public subnets (load balancer) and private subnets (containers, database).
- **Containers:** ECS on Fargate for three long-lived services, `api` (REST and SSE) and two worker types. They are long-lived because SSE and LISTEN/NOTIFY can't run on serverless (EXT-41).
- **Load balancer:** an Application Load Balancer that routes `/api/*` to the API and everything else to the dashboard, so both share one origin (review A-07).
- **Database:** RDS for PostgreSQL 17 with Multi-AZ and point-in-time recovery for 35 days, plus automated backups replicated to eu-west-1. The roles `migrator`, `app_runtime`, `system_worker` and `retention_worker` are created once with `bootstrapRoles()`, using passwords from Secrets Manager.
- **Files:** S3 with Block Public Access, KMS encryption and versioning, replicated to eu-west-1.
- **Secrets and detection:** Secrets Manager; CloudTrail and GuardDuty; WAF in front of the API.

## Deviation from the Phase 0 plan

The plan said the Terraform for this cell would be written in Phase 0, without being applied. It moves to Phase 1. Terraform that can't be planned against a real account (EXT-14) can't be checked, and unchecked infrastructure code is the kind of doc-versus-reality drift the spec warns about. Phase 1 writes it, and validates it with `terraform plan` against the staging account.
