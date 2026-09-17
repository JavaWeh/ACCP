package recovery

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// Quarantine revokes restored authority before runtime privileges are installed.
func Quarantine(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `
 UPDATE runtime_state SET maintenance=true,recovery_pending=true,reason='RESTORE_REQUIRES_RECONCILIATION',changed_at=clock_timestamp();
 UPDATE agent_sessions SET status='REVOKED',version=version+1 WHERE status='ACTIVE';
 INSERT INTO recovery_items(id,project_id,kind,resource_id) SELECT 'recovery_tool_'||id,project_id,'TOOL',id FROM tool_invocations WHERE status IN ('READY','RUNNING','AWAITING_APPROVAL','UNKNOWN') ON CONFLICT DO NOTHING;
 INSERT INTO recovery_items(id,project_id,kind,resource_id) SELECT 'recovery_run_'||id,project_id,'RUN',id FROM task_runs WHERE status='RUNNING' ON CONFLICT DO NOTHING;
 UPDATE tool_invocations SET status='UNKNOWN',document=document||jsonb_build_object('status','UNKNOWN','version',(document->>'version')::bigint+1,'error_code','RESTORE_OUTCOME_UNKNOWN') WHERE status IN ('READY','RUNNING','AWAITING_APPROVAL');
 UPDATE task_runs SET status='LOST',version=version+1,document=document||jsonb_build_object('status','LOST','version',version+1) WHERE status='RUNNING';
 UPDATE tasks SET status='BLOCKED',version=version+1,retry_authorized=false,document=document||jsonb_build_object('status','BLOCKED','version',version+1) WHERE status IN ('RUNNING','READY','BLOCKED');
 UPDATE outbox_events SET delivered_at=NULL,next_attempt_at=now(),replay_version=replay_version+1 WHERE NOT EXISTS(SELECT 1 FROM event_feed f WHERE f.event_id=outbox_events.id);
 DELETE FROM worker_health;
 `)
	return err
}
