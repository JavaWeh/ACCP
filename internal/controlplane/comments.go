package controlplane

import (
	"encoding/base64"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// F11 advisory task comments. These handlers deliberately touch only the
// task_comments table and the F3 notification projection: a comment is a
// discussion note, never a command, so no path here reads or writes a task's
// status/version. The request schema (CreateComment/EditComment) is
// additionalProperties:false with no status field, so a payload cannot even
// carry a transition; the write would be rejected at the contract before any
// handler runs. The server resolves membership for the parent task through the
// `table:"tasks"` operation gate, so a non-member is a 404 and a role-bearing
// member reaches these handlers already authenticated.

// commentCursor binds an oldest-first page position to its collection path and
// the (created_at, id) sort key, so a cursor minted for one task's thread can
// never skip rows in another.
type commentCursor struct {
	Path string
	At   string
	ID   string
}

// listComments returns a task's comment thread oldest-first (O-W14), so the
// console can append new comments at the bottom and scroll to them. Soft-deleted
// comments remain in the thread as tombstones with their body cleared.
func listComments(q *request) (reply, error) {
	taskID := q.http.PathValue("id")
	limit := 50
	if raw := q.http.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			return reply{}, fail(400, "INVALID_PAGE", "limit must be between 1 and 100.")
		}
		limit = n
	}
	var cur commentCursor
	if raw := q.http.URL.Query().Get("cursor"); raw != "" {
		data, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil || json.Unmarshal(data, &cur) != nil || cur.Path != q.http.URL.Path || cur.ID == "" || len(cur.ID) > 128 {
			return reply{}, fail(400, "INVALID_CURSOR", "The cursor must belong to this collection.")
		}
	}
	query := `SELECT c.id,c.author_user_id,u.display_name,c.body,c.mentions,c.edited,c.deleted,c.created_at,c.updated_at
		FROM task_comments c JOIN human_users u ON u.id=c.author_user_id AND u.organization_id=c.organization_id
		WHERE c.task_id=$1 AND c.project_id=$2 AND c.organization_id=$3`
	args := []any{taskID, q.project, q.org, limit + 1}
	if cur.ID != "" {
		query += ` AND (c.created_at,c.id) > ($5::timestamptz,$6)`
		args = append(args, cur.At, cur.ID)
	}
	query += ` ORDER BY c.created_at ASC, c.id ASC LIMIT $4`
	rows, err := q.tx.Query(q.http.Context(), query, args...)
	if err != nil {
		return reply{}, err
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		doc, at, err := scanComment(rows, q, taskID)
		if err != nil {
			return reply{}, err
		}
		doc["_at"] = at
		items = append(items, doc)
	}
	if err = rows.Err(); err != nil {
		return reply{}, err
	}
	body := Object{"items": items, "next_cursor": nil}
	if len(items) > limit {
		trimmed := items[limit-1]
		items = items[:limit]
		body["items"] = items
		encoded, _ := json.Marshal(commentCursor{Path: q.http.URL.Path, At: textValue(trimmed, "_at"), ID: textValue(trimmed, "id")})
		body["next_cursor"] = base64.RawURLEncoding.EncodeToString(encoded)
	}
	for _, item := range items {
		delete(item, "_at")
	}
	return reply{status: 200, body: body}, nil
}

// createComment records an advisory comment and, for each validated @mention,
// projects a COMMENT_MENTION notification through the same F3 mechanism every
// other event uses (projectNotifications). It never emits a domain command or
// touches the task, so the parent task's status and version are unchanged by
// construction.
func createComment(q *request) (reply, error) {
	taskID := q.http.PathValue("id")
	body := textValue(q.body, "body")
	if strings.TrimSpace(body) == "" {
		return reply{}, fail(400, "EMPTY_COMMENT", "A comment must contain non-whitespace text.")
	}
	mentions, err := validateMentions(q)
	if err != nil {
		return reply{}, err
	}
	id := newID("comment")
	if _, err = q.tx.Exec(q.http.Context(), `INSERT INTO task_comments(id,organization_id,project_id,task_id,author_user_id,body,mentions) VALUES($1,$2,$3,$4,$5,$6,$7)`, id, q.org, q.project, taskID, q.user, body, mentions); err != nil {
		return reply{}, err
	}
	// Fan out mention notifications via the existing F3 projection. A comment is
	// advisory, so it is not an outbox/event_feed fact; the projection runs in
	// this request's transaction so the recipient's badge and the comment commit
	// or roll back together.
	if len(mentions) > 0 {
		recipients := make([]any, len(mentions))
		for i, m := range mentions {
			recipients[i] = m
		}
		if err = projectNotifications(q, "COMMENT_MENTION", Object{"task_id": taskID, "mentions": recipients}); err != nil {
			return reply{}, err
		}
	}
	doc, err := commentByID(q, id, taskID)
	if err != nil {
		return reply{}, err
	}
	return reply{status: 201, resource: id, version: 1, body: doc}, nil
}

// editComment lets the author revise their own comment and marks it edited.
// Only the author may edit; anyone else (including an admin) gets a 404 rather
// than a hint that the comment exists.
func editComment(q *request) (reply, error) {
	taskID, cid := q.http.PathValue("id"), q.http.PathValue("cid")
	body := textValue(q.body, "body")
	if strings.TrimSpace(body) == "" {
		return reply{}, fail(400, "EMPTY_COMMENT", "A comment must contain non-whitespace text.")
	}
	tag, err := q.tx.Exec(q.http.Context(), `UPDATE task_comments SET body=$1,edited=true,updated_at=now() WHERE id=$2 AND task_id=$3 AND project_id=$4 AND organization_id=$5 AND author_user_id=$6 AND NOT deleted`, body, cid, taskID, q.project, q.org, q.user)
	if err != nil {
		return reply{}, err
	}
	if tag.RowsAffected() != 1 {
		return reply{}, fail(404, "NOT_FOUND", "Comment not found.")
	}
	doc, err := commentByID(q, cid, taskID)
	if err != nil {
		return reply{}, err
	}
	return reply{status: 200, resource: cid, version: 1, body: doc}, nil
}

// deleteComment soft-deletes a comment (tombstone, body cleared); hard deletes
// are not offered so the thread stays intact. The author may delete their own
// comment and a project ADMIN may delete any comment on the task.
func deleteComment(q *request) (reply, error) {
	taskID, cid := q.http.PathValue("id"), q.http.PathValue("cid")
	sql := `UPDATE task_comments SET deleted=true,body='',mentions='{}',updated_at=now() WHERE id=$1 AND task_id=$2 AND project_id=$3 AND organization_id=$4`
	args := []any{cid, taskID, q.project, q.org}
	if !hasRole(q.roles, "ADMIN") {
		sql += ` AND author_user_id=$5`
		args = append(args, q.user)
	}
	tag, err := q.tx.Exec(q.http.Context(), sql, args...)
	if err != nil {
		return reply{}, err
	}
	if tag.RowsAffected() != 1 {
		return reply{}, fail(404, "NOT_FOUND", "Comment not found.")
	}
	doc, err := commentByID(q, cid, taskID)
	if err != nil {
		return reply{}, err
	}
	return reply{status: 200, resource: cid, version: 1, body: doc}, nil
}

// validateMentions parses the optional mentions array and confirms every id is
// a currently-active member of the task's project, returning a deduplicated
// list. An id that is not an active member is rejected with 400 so an invalid
// mention cannot silently create a comment; the draft is preserved client-side.
func validateMentions(q *request) ([]string, error) {
	ids, ok := mentionIDs(q.body["mentions"])
	if !ok {
		return nil, fail(400, "INVALID_MENTION", "Each mention must be a member id.")
	}
	if len(ids) == 0 {
		return nil, nil
	}
	var count int
	err := q.tx.QueryRow(q.http.Context(), `SELECT count(*) FROM memberships m JOIN human_users u ON u.id=m.user_id AND u.organization_id=m.organization_id WHERE m.project_id=$1 AND m.organization_id=$2 AND m.active AND u.active AND m.user_id=ANY($3)`, q.project, q.org, ids).Scan(&count)
	if err != nil {
		return nil, err
	}
	if count != len(ids) {
		return nil, fail(400, "INVALID_MENTION", "Mentions must name active members of this project.")
	}
	return ids, nil
}

// mentionIDs normalizes the optional mentions field from a decoded request
// body into a deduplicated, order-preserving list of ids. It reports ok=false
// only when the field is present but holds a non-string element; an absent
// field yields an empty list and ok=true. Membership validity is checked
// separately against the database.
func mentionIDs(raw any) ([]string, bool) {
	list, ok := raw.([]any)
	if !ok {
		return nil, true
	}
	seen := map[string]bool{}
	ids := []string{}
	for _, value := range list {
		id, ok := value.(string)
		if !ok {
			return nil, false
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids, true
}

// commentByID reads one comment joined with its author's display name and
// returns its response document. A missing comment is a 404.
func commentByID(q *request, cid, taskID string) (Object, error) {
	rows, err := q.tx.Query(q.http.Context(), `SELECT c.id,c.author_user_id,u.display_name,c.body,c.mentions,c.edited,c.deleted,c.created_at,c.updated_at
		FROM task_comments c JOIN human_users u ON u.id=c.author_user_id AND u.organization_id=c.organization_id
		WHERE c.id=$1 AND c.task_id=$2 AND c.project_id=$3 AND c.organization_id=$4`, cid, taskID, q.project, q.org)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err = rows.Err(); err != nil {
			return nil, err
		}
		return nil, fail(404, "NOT_FOUND", "Comment not found.")
	}
	doc, _, err := scanComment(rows, q, taskID)
	return doc, err
}

// scanComment maps one comment row to its response document and returns the raw
// created_at used as the keyset cursor position. A soft-deleted comment reports
// deleted=true with an empty body so the tombstone renders without leaking the
// original text.
func scanComment(rows pgx.Rows, q *request, taskID string) (Object, string, error) {
	var id, author, authorName, body string
	var mentions []string
	var edited, deleted bool
	var createdAt, updatedAt time.Time
	if err := rows.Scan(&id, &author, &authorName, &body, &mentions, &edited, &deleted, &createdAt, &updatedAt); err != nil {
		return nil, "", err
	}
	if mentions == nil {
		mentions = []string{}
	}
	return Object{
		"id": id, "organization_id": q.org, "project_id": q.project, "task_id": taskID,
		"author_user_id": author, "author_name": authorName, "body": body,
		"mentions": mentions, "edited": edited, "deleted": deleted,
		"created_at": createdAt.UTC().Format(time.RFC3339Nano),
		"updated_at": updatedAt.UTC().Format(time.RFC3339Nano),
		"version":    int64(1),
	}, createdAt.UTC().Format(time.RFC3339Nano), nil
}
