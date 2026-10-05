-- #272 F-023 FF-6: a project says what it is for. One line, set and changed by people who can edit
-- the project; NULL until someone writes one. 0052 is reserved by #270 (GitHub task rules).
ALTER TABLE projects ADD COLUMN goal text;
ALTER TABLE projects ADD CONSTRAINT project_goal_length
  CHECK (goal IS NULL OR (char_length(goal) BETWEEN 1 AND 200 AND goal = btrim(goal)));
