-- =============================================================================
-- Migration: add_service_model_to_establishment
-- PR1 — ServiceModel: COUNTER / DINE_IN
-- =============================================================================

DO $$
DECLARE
  existing_values TEXT[];
  expected_values TEXT[] := ARRAY['COUNTER', 'DINE_IN'];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ServiceModel') THEN
    SELECT ARRAY_AGG(e.enumlabel ORDER BY e.enumsortorder)
    INTO existing_values
    FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'ServiceModel';

    IF existing_values <> expected_values THEN
      RAISE EXCEPTION
        'CONFLICTO: Enum ServiceModel existe pero tiene valores [%], se esperaba [COUNTER, DINE_IN].',
        ARRAY_TO_STRING(existing_values, ', ');
    END IF;
  ELSE
    CREATE TYPE "ServiceModel" AS ENUM ('COUNTER', 'DINE_IN');
  END IF;
END $$;

ALTER TABLE "Establishment"
  ADD COLUMN IF NOT EXISTS "serviceModel" "ServiceModel" NOT NULL DEFAULT 'DINE_IN';

DO $$
DECLARE
  null_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM "Establishment"
  WHERE "serviceModel" IS NULL;

  IF null_count > 0 THEN
    RAISE EXCEPTION 'PR1 FALLIDO: % fila(s) tienen serviceModel NULL.', null_count;
  END IF;
END $$;
