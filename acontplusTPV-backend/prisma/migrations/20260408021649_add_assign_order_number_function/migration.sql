CREATE OR REPLACE FUNCTION assign_order_number(
  p_order_id  uuid,
  p_pos_id    uuid,
  p_tenant_id uuid
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_seq          int;
  v_est_code     text;
  v_pos_code     text;
  v_order_number text;
BEGIN
  -- Incrementar el secuencial del POS de forma atómica
  UPDATE "PointOfSale"
    SET "lastSequential" = "lastSequential" + 1
    WHERE id          = p_pos_id
      AND "tenantId"  = p_tenant_id
    RETURNING "lastSequential", code
    INTO v_seq, v_pos_code;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PointOfSale % not found for tenant %',
      p_pos_id, p_tenant_id;
  END IF;

  -- Obtener el código del establecimiento
  SELECT e.code INTO v_est_code
    FROM "Establishment" e
    JOIN "PointOfSale"   pos ON pos."establishmentId" = e.id
    WHERE pos.id         = p_pos_id
      AND pos."tenantId" = p_tenant_id;

  -- Formatear: "001-001-000000001"
  v_order_number := v_est_code
                 || '-' || v_pos_code
                 || '-' || LPAD(v_seq::text, 9, '0');

  -- Asignar solo si el pedido aún no tiene número (idempotente)
  UPDATE "Order"
    SET "orderNumber"  = v_order_number
    WHERE id           = p_order_id
      AND "tenantId"   = p_tenant_id
      AND "orderNumber" IS NULL;

  -- Si ya tenía número (sync duplicado), devolver el existente
  IF NOT FOUND THEN
    SELECT "orderNumber" INTO v_order_number
      FROM "Order"
      WHERE id = p_order_id;
  END IF;

  RETURN v_order_number;
END;
$$;