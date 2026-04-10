CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS 
  "PayrollRecord_tenant_user_period_key"
ON "PayrollRecord" ("tenantId", "userId", "periodStart", "periodEnd");