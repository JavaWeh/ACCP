CREATE TRIGGER task_changes_immutable BEFORE UPDATE OR DELETE ON task_changes
FOR EACH ROW EXECUTE FUNCTION reject_mutation();
