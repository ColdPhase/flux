-- Who a notification comes from is written with it (personas-28 P2 4): the person or agent its title names, as a principal
-- (`human:<id>`, `agent:<id>`), set by the generator from what it found. It was read from the actor of the event the row came from, which is
-- not the asker for a question that reaches someone who joins later (the actor is the joiner, or whoever added them). Rows written before
-- this have none, and their face falls back to the event's actor; a notification made directly has none.
ALTER TABLE public.notifications ADD COLUMN from_actor text;
