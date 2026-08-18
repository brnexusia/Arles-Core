CREATE OR REPLACE FUNCTION cash_reset_pocket_allocation_on_deactivate()
RETURNS trigger AS $$
BEGIN
  IF OLD.active = true AND NEW.active = false THEN
    NEW.allocation_balance := 0;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cash_reset_pocket_allocation_on_deactivate ON cash_pockets;
CREATE TRIGGER trg_cash_reset_pocket_allocation_on_deactivate
BEFORE UPDATE OF active ON cash_pockets
FOR EACH ROW
EXECUTE FUNCTION cash_reset_pocket_allocation_on_deactivate();
