package controlplane

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strconv"
	"time"
)

// notificationRetention bounds how far back the ledger is read, matching the
// event feed's seven-day window (enforced at read time, no separate reaper).
const notificationRetention = "7 days"

// notificationCursor binds a page position to the collection path and the
// newest-first (occurred_at, id) sort key. A cursor minted for one path must
// never silently skip rows in another collection.
type notificationCursor struct {
	Path string
	At   string
	ID   string
}

// listNotifications returns the caller's recent notifications newest-first. It
// is user-scoped (no project/table): authentication yields q.user and q.org,
// and every row is filtered to the caller. Retention matches the event feed
// (seven days); the optional unread=true filter drives the panel's "unread"
// chip. This is read-only polling, never a realtime guarantee — the badge and
// panel reconcile on the same cadence as F1's ConnectionStatus poll.
func listNotifications(q *request) (reply, error) {
	limit := 50
	if raw := q.http.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			return reply{}, fail(400, "INVALID_PAGE", "limit must be between 1 and 100.")
		}
		limit = n
	}
	var curAt, curID string
	if raw := q.http.URL.Query().Get("cursor"); raw != "" {
		data, err := base64.RawURLEncoding.DecodeString(raw)
		var c notificationCursor
		if err != nil || json.Unmarshal(data, &c) != nil || c.Path != q.http.URL.Path || c.ID == "" || len(c.ID) > 128 {
			return reply{}, fail(400, "INVALID_CURSOR", "The cursor must belong to this collection.")
		}
		curAt, curID = c.At, c.ID
	}
	query := `SELECT n.id,n.type,n.project_id,p.name,n.title,n.deep_link,n.occurred_at,(n.read_at IS NOT NULL)
		FROM notifications n
		JOIN projects p ON p.id=n.project_id AND p.organization_id=n.organization_id
		WHERE n.organization_id=$1 AND n.user_id=$2 AND n.occurred_at>now()-interval '` + notificationRetention + `'`
	args := []any{q.org, q.user, limit + 1}
	if q.http.URL.Query().Get("unread") == "true" {
		query += ` AND n.read_at IS NULL`
	}
	if curID != "" {
		query += ` AND (n.occurred_at,n.id) < ($4::timestamptz,$5)`
		args = append(args, curAt, curID)
	}
	query += ` ORDER BY n.occurred_at DESC, n.id DESC LIMIT $3`
	rows, err := q.tx.Query(q.http.Context(), query, args...)
	if err != nil {
		return reply{}, err
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var id, typ, projectID, projectName, title, deepLink string
		var occurredAt time.Time
		var read bool
		if err = rows.Scan(&id, &typ, &projectID, &projectName, &title, &deepLink, &occurredAt, &read); err != nil {
			return reply{}, err
		}
		items = append(items, Object{
			"id": id, "type": typ, "project_id": projectID, "project_name": projectName,
			"title": title, "occurred_at": occurredAt.UTC().Format(time.RFC3339Nano), "deep_link": deepLink, "read": read,
		})
	}
	if err = rows.Err(); err != nil {
		return reply{}, err
	}
	body := Object{"items": items, "next_cursor": nil}
	if len(items) > limit {
		body["items"] = items[:limit]
		trimmed := items[limit-1]
		encoded, _ := json.Marshal(notificationCursor{Path: q.http.URL.Path, At: textValue(trimmed, "occurred_at"), ID: textValue(trimmed, "id")})
		body["next_cursor"] = base64.RawURLEncoding.EncodeToString(encoded)
	}
	return reply{status: 200, body: body}, nil
}

// notificationSummary returns the caller's unread count within the retention
// window. The front end renders 99+ past a hundred, but the server reports the
// true count so the badge is exact below that threshold.
func notificationSummary(q *request) (reply, error) {
	var count int64
	err := q.tx.QueryRow(q.http.Context(), `SELECT count(*) FROM notifications WHERE organization_id=$1 AND user_id=$2 AND read_at IS NULL AND occurred_at>now()-interval '`+notificationRetention+`'`, q.org, q.user).Scan(&count)
	if err != nil {
		return reply{}, err
	}
	return reply{status: 200, body: Object{"unread_count": count}}, nil
}

// markNotificationRead marks one of the caller's own notifications read. It is
// idempotent (coalesce keeps the first read instant), and a missing or
// foreign row is a 404 so one user can never probe or mutate another's ledger.
func markNotificationRead(q *request) (reply, error) {
	id := q.http.PathValue("id")
	tag, err := q.tx.Exec(q.http.Context(), `UPDATE notifications SET read_at=coalesce(read_at,now()) WHERE id=$1 AND organization_id=$2 AND user_id=$3`, id, q.org, q.user)
	if err != nil {
		return reply{}, err
	}
	if tag.RowsAffected() != 1 {
		return reply{}, fail(404, "NOT_FOUND", "Notification not found.")
	}
	return reply{status: 200, body: Object{"id": id, "read": true}}, nil
}

// markAllNotificationsRead marks the caller's unread notifications read,
// optionally only those at or before an RFC3339 `before` instant. It returns
// the remaining unread count so the badge can settle without a second round
// trip.
func markAllNotificationsRead(q *request) (reply, error) {
	var before any
	if raw := q.http.URL.Query().Get("before"); raw != "" {
		t, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			return reply{}, fail(400, "INVALID_FILTER", "before must be an RFC3339 timestamp.")
		}
		before = t
	}
	if _, err := q.tx.Exec(q.http.Context(), `UPDATE notifications SET read_at=now() WHERE organization_id=$1 AND user_id=$2 AND read_at IS NULL AND ($3::timestamptz IS NULL OR occurred_at<=$3::timestamptz)`, q.org, q.user, before); err != nil {
		return reply{}, err
	}
	return notificationSummary(q)
}

// projectNotifications projects a just-emitted project event onto the per-user
// notification ledger, in the same transaction as the event. The mapping from
// event kind to the user-facing notification taxonomy (US-20 / Q-F3-2) is the
// only place recipients are derived, reusing the My Work membership semantics:
// task events notify the owner; approval requests notify active reviewers.
// Recipients that are not currently active members receive nothing (the
// deactivated-member counterexample). Unknown kinds project nothing.
func projectNotifications(q *request, kind string, detail Object) error {
	taskID := textValue(detail, "task_id")
	switch kind {
	case "TASK_ASSIGNED":
		return insertNotification(q, textValue(detail, "owner_user_id"), "TASK_ASSIGNED", taskID, taskTitle(q, taskID), taskLink(q.project, taskID))
	case "REVIEW_REQUIRED":
		return insertNotification(q, textValue(detail, "owner_user_id"), "REVIEW_REQUIRED", taskID, taskTitle(q, taskID), taskLink(q.project, taskID))
	case "TASK_FAILED":
		// A failed or lost Run leaves the task BLOCKED / needing attention; the
		// owner is the recipient. The event detail omits the owner, so resolve
		// it from the task the event is about.
		return insertNotification(q, taskOwner(q, taskID), "TASK_BLOCKED", taskID, taskTitle(q, taskID), taskLink(q.project, taskID))
	case "APPROVAL_REQUESTED":
		return projectApprovalNotification(q, detail)
	case "COMMENT_MENTION":
		return projectMentionNotifications(q, detail)
	}
	return nil
}

// projectApprovalNotification notifies every active reviewer or administrator
// of the project (the My Work approval audience). Recipients are collected
// before any insert so the single transaction connection is never used for a
// write while a result set is still open.
func projectApprovalNotification(q *request, detail Object) error {
	approvalID := textValue(detail, "approval_id")
	title := taskTitle(q, textValue(detail, "task_id"))
	if title == "" {
		title = approvalID
	}
	link := approvalLink(q.project, approvalID)
	rows, err := q.tx.Query(q.http.Context(), `SELECT m.user_id FROM memberships m JOIN human_users u ON u.id=m.user_id AND u.organization_id=m.organization_id WHERE m.project_id=$1 AND m.organization_id=$2 AND m.active AND u.active AND ('REVIEWER'=ANY(m.roles) OR 'ADMIN'=ANY(m.roles))`, q.project, q.org)
	if err != nil {
		return err
	}
	recipients := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		recipients = append(recipients, id)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	for _, id := range recipients {
		if _, err = q.tx.Exec(q.http.Context(), `INSERT INTO notifications(id,organization_id,project_id,user_id,type,subject,title,deep_link) VALUES($1,$2,$3,$4,'APPROVAL_PENDING',$5,$6,$7)`, newID("notif"), q.org, q.project, id, approvalID, title, link); err != nil {
			return err
		}
	}
	return nil
}

// projectMentionNotifications notifies each @-mentioned user (F11). It is
// defined here so the F3 projection is complete the moment comments emit a
// COMMENT_MENTION event; until then no caller produces this kind.
func projectMentionNotifications(q *request, detail Object) error {
	taskID := textValue(detail, "task_id")
	title := taskTitle(q, taskID)
	link := commentLink(q.project, taskID)
	mentions, _ := detail["mentions"].([]any)
	for _, raw := range mentions {
		if user, ok := raw.(string); ok {
			if err := insertNotification(q, user, "COMMENT_MENTION", taskID, title, link); err != nil {
				return err
			}
		}
	}
	return nil
}

// insertNotification writes one notification only when the recipient is a
// currently-active member with an active account. A blank recipient or a
// deactivated/non-member target is silently skipped so a projection never
// fails on a stale owner reference.
func insertNotification(q *request, userID, typ, subject, title, deepLink string) error {
	if userID == "" {
		return nil
	}
	var active bool
	err := q.tx.QueryRow(q.http.Context(), `SELECT EXISTS(SELECT 1 FROM memberships m JOIN human_users u ON u.id=m.user_id AND u.organization_id=m.organization_id WHERE m.project_id=$1 AND m.organization_id=$2 AND m.user_id=$3 AND m.active AND u.active)`, q.project, q.org, userID).Scan(&active)
	if err != nil {
		return err
	}
	if !active {
		return nil
	}
	_, err = q.tx.Exec(q.http.Context(), `INSERT INTO notifications(id,organization_id,project_id,user_id,type,subject,title,deep_link) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, newID("notif"), q.org, q.project, userID, typ, subject, title, deepLink)
	return err
}

// taskTitle reads a task's current title for the notification label, tolerating
// a missing task (returns empty) so projection never blocks on a race.
func taskTitle(q *request, taskID string) string {
	if taskID == "" {
		return ""
	}
	var title string
	_ = q.tx.QueryRow(q.http.Context(), `SELECT coalesce(document->>'title','') FROM tasks WHERE id=$1 AND project_id=$2 AND organization_id=$3`, taskID, q.project, q.org).Scan(&title)
	return title
}

// taskOwner reads a task's owner for events whose detail omits it (TASK_FAILED).
func taskOwner(q *request, taskID string) string {
	if taskID == "" {
		return ""
	}
	var owner string
	_ = q.tx.QueryRow(q.http.Context(), `SELECT owner_user_id FROM tasks WHERE id=$1 AND project_id=$2 AND organization_id=$3`, taskID, q.project, q.org).Scan(&owner)
	return owner
}

// taskLink deep-links to the project-scoped task route (console routing.ts).
func taskLink(project, taskID string) string {
	return "/projects/" + url.PathEscape(project) + "/tasks/" + url.PathEscape(taskID)
}

// approvalLink deep-links to the project's approval list. Approvals have no
// per-item route, so the id rides as a query parameter (O-W11, query form):
// console routing ignores the query, but the URL still identifies the approval
// for any future highlight without a routing change.
func approvalLink(project, approvalID string) string {
	return "/projects/" + url.PathEscape(project) + "/approvals?approval=" + url.QueryEscape(approvalID)
}

// commentLink deep-links to a task's comment thread (F11 anchor).
func commentLink(project, taskID string) string {
	return taskLink(project, taskID) + "#comments"
}
