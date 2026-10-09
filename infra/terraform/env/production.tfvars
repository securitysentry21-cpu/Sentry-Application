# Production: the Paid plan, its own account, the full baseline (ARCH §19.8). Set the domain first.
environment         = "production"
domain              = "" # required before the first apply, e.g. "getsentryops.com"
db_multi_az         = true
backup_copy_enabled = true
waf_enabled         = true
monthly_budget_usd  = 200
