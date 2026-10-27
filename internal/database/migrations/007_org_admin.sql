ALTER TABLE human_users ADD COLUMN is_org_admin boolean NOT NULL DEFAULT false;
UPDATE human_users SET is_org_admin = true
WHERE id = (
  SELECT m.user_id FROM memberships m
  JOIN human_users u ON u.id = m.user_id
  WHERE m.active AND u.active AND 'ADMIN' = ANY (m.roles)
  ORDER BY m.user_id
  LIMIT 1
);
