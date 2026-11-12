-- The account-scoped command `PUT /api/v1/personal-assistant/model` is gone (#1120): an agent's model is changed with
-- `PATCH /api/v1/my-agents/:agentId`, which is already in the list. Works on data left by v0.2.0: it only removes a row of the list,
-- and responses already stored for the old operation keep their rows (the guard looks at new rows only).
DELETE FROM public.idempotency_account_operations WHERE operation = 'PUT /api/v1/personal-assistant/model';
