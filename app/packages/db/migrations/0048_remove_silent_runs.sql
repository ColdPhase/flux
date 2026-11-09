-- #1104: a schedule's result goes only to its agent's private chat (founder answer 2026-11-08), and is shared by the owner's Show everyone. A run whose
-- result was kept out of its conversation ("silent", the schedule's choice not to post it) has nothing left to say: no run is ever posted for the owner.
ALTER TABLE public.personal_runs DROP COLUMN silent;
