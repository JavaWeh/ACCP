// Package recovery implements authenticated encrypted, snapshot-consistent backups.
package recovery

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"filippo.io/age"
	"github.com/jackc/pgx/v5"
)

type Table struct {
	Rows   int64  `json:"rows"`
	SHA256 string `json:"sha256"`
}
type Manifest struct {
	Format        int               `json:"format"`
	SnapshotAt    time.Time         `json:"snapshot_at"`
	FinishedAt    time.Time         `json:"finished_at"`
	Image         string            `json:"image"`
	Configuration map[string]string `json:"configuration"`
	Migrations    map[string]string `json:"migrations"`
	Tables        map[string]Table  `json:"tables"`
	DumpSHA256    string            `json:"dump_sha256"`
}

// Fingerprints uses ordered canonical JSON including all evidence and ledger columns.
func Fingerprints(ctx context.Context, tx pgx.Tx) (map[string]Table, error) {
	rows, err := tx.Query(ctx, `SELECT tablename FROM pg_tables WHERE schemaname='accp' ORDER BY tablename`)
	if err != nil {
		return nil, err
	}
	var names []string
	for rows.Next() {
		var n string
		if err = rows.Scan(&n); err != nil {
			rows.Close()
			return nil, err
		}
		names = append(names, n)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	result := map[string]Table{}
	for _, name := range names {
		h := sha256.New()
		var count int64
		r, e := tx.Query(ctx, `SELECT to_jsonb(t)::text FROM `+pgx.Identifier{"accp", name}.Sanitize()+` t ORDER BY to_jsonb(t)::text COLLATE "C"`)
		if e != nil {
			return nil, e
		}
		for r.Next() {
			var line string
			if e = r.Scan(&line); e != nil {
				r.Close()
				return nil, e
			}
			fmt.Fprintln(h, line)
			count++
		}
		e = r.Err()
		r.Close()
		if e != nil {
			return nil, e
		}
		result[name] = Table{count, hex.EncodeToString(h.Sum(nil))}
	}
	return result, nil
}

func command(ctx context.Context, connection, program string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, program, args...)
	// Connection strings never appear in argv or subprocess output.
	u, err := url.Parse(connection)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.User == nil {
		cmd.Err = errors.New("operator database URL must be a PostgreSQL URI")
		return cmd
	}
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "PG") {
			cmd.Env = append(cmd.Env, value)
		}
	}
	password, _ := u.User.Password()
	port := u.Port()
	if port == "" {
		port = "5432"
	}
	cmd.Env = append(cmd.Env, "PGHOST="+u.Hostname(), "PGPORT="+port, "PGUSER="+u.User.Username(), "PGPASSWORD="+password, "PGDATABASE="+strings.TrimPrefix(u.Path, "/"), "PGOPTIONS=-c search_path=accp,public", "PGCONNECT_TIMEOUT=10")
	for _, option := range []string{"sslmode", "sslrootcert", "sslcert", "sslkey"} {
		if value := u.Query().Get(option); value != "" {
			cmd.Env = append(cmd.Env, "PG"+strings.ToUpper(option)+"="+value)
		}
	}
	return cmd
}

func Backup(ctx context.Context, url, recipient, output, image string, configuration map[string]string) (Manifest, error) {
	m := Manifest{Format: 1, Image: image, Configuration: configuration, Migrations: map[string]string{}}
	if !strings.Contains(image, "sha256:") {
		return m, errors.New("an immutable image digest is required")
	}
	r, err := age.ParseX25519Recipient(recipient)
	if err != nil {
		return m, errors.New("invalid backup recipient")
	}
	db, err := pgx.Connect(ctx, url)
	if err != nil {
		return m, errors.New("backup database unavailable")
	}
	defer db.Close(ctx)
	tx, err := db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return m, err
	}
	defer tx.Rollback(ctx)
	// Migration takes the exclusive form of this lock. Keep DDL out of the
	// interval shared by the exported snapshot, fingerprints and pg_dump.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared(1094927184)`); err != nil {
		return m, err
	}
	var snapshot string
	if err = tx.QueryRow(ctx, `SELECT pg_export_snapshot(),clock_timestamp()`).Scan(&snapshot, &m.SnapshotAt); err != nil {
		return m, err
	}
	rows, err := tx.Query(ctx, `SELECT name,checksum FROM accp.schema_migrations ORDER BY name`)
	if err != nil {
		return m, err
	}
	for rows.Next() {
		var n, d string
		if err = rows.Scan(&n, &d); err != nil {
			rows.Close()
			return m, err
		}
		m.Migrations[n] = d
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return m, err
	}
	if m.Tables, err = Fingerprints(ctx, tx); err != nil {
		return m, err
	}
	temp, err := os.MkdirTemp("", "accp-backup-")
	if err != nil {
		return m, err
	}
	defer os.RemoveAll(temp)
	dump := filepath.Join(temp, "database.dump")
	cmd := command(ctx, url, "pg_dump", "--format=custom", "--no-owner", "--no-privileges", "--schema=accp", "--snapshot="+snapshot, "--file="+dump)
	if err = cmd.Run(); err != nil {
		return m, errors.New("snapshot database export failed")
	}
	if err = tx.Commit(ctx); err != nil {
		return m, err
	}
	f, err := os.Open(dump)
	if err != nil {
		return m, err
	}
	defer f.Close()
	h := sha256.New()
	size, err := io.Copy(h, f)
	if err != nil {
		return m, err
	}
	m.DumpSHA256 = hex.EncodeToString(h.Sum(nil))
	m.FinishedAt = time.Now().UTC()
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return m, err
	}
	out, err := os.OpenFile(output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return m, err
	}
	success := false
	defer func() {
		out.Close()
		if !success {
			os.Remove(output)
		}
	}()
	encrypted, err := age.Encrypt(out, r)
	if err != nil {
		return m, err
	}
	archive := tar.NewWriter(encrypted)
	data, err := json.Marshal(m)
	if err != nil {
		return m, err
	}
	for _, entry := range []struct {
		name   string
		size   int64
		reader io.Reader
	}{{"manifest.json", int64(len(data)), strings.NewReader(string(data))}, {"database.dump", size, f}} {
		if err = archive.WriteHeader(&tar.Header{Name: entry.name, Mode: 0600, Size: entry.size}); err != nil {
			return m, err
		}
		if _, err = io.Copy(archive, entry.reader); err != nil {
			return m, err
		}
	}
	if err = archive.Close(); err != nil {
		return m, err
	}
	if err = encrypted.Close(); err != nil {
		return m, err
	}
	if err = out.Sync(); err != nil {
		return m, err
	}
	success = true
	return m, nil
}

// Open verifies the entire authenticated stream before returning any restore input.
// Only two fixed regular files are accepted; archive paths are never extracted.
func Open(input, identityFile, temp string) (Manifest, string, error) {
	var m Manifest
	key, err := os.ReadFile(identityFile)
	if err != nil {
		return m, "", errors.New("identity file unavailable")
	}
	identities, err := age.ParseIdentities(strings.NewReader(string(key)))
	if err != nil || len(identities) == 0 {
		return m, "", errors.New("invalid backup identity")
	}
	f, err := os.Open(input)
	if err != nil {
		return m, "", err
	}
	defer f.Close()
	decrypted, err := age.Decrypt(f, identities...)
	if err != nil {
		return m, "", errors.New("backup authentication failed")
	}
	archive := tar.NewReader(decrypted)
	dump := filepath.Join(temp, "database.dump")
	seen := map[string]bool{}
	for {
		header, e := archive.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return m, "", errors.New("invalid encrypted archive")
		}
		if header.Typeflag != tar.TypeReg || seen[header.Name] || header.Size < 1 {
			return m, "", errors.New("invalid archive entry")
		}
		seen[header.Name] = true
		switch header.Name {
		case "manifest.json":
			if header.Size > 1024*1024 {
				return m, "", errors.New("manifest exceeds limit")
			}
			data, e := io.ReadAll(archive)
			if e != nil {
				return m, "", e
			}
			decoder := json.NewDecoder(strings.NewReader(string(data)))
			decoder.DisallowUnknownFields()
			if e = decoder.Decode(&m); e != nil {
				return m, "", errors.New("invalid manifest")
			}
		case "database.dump":
			out, e := os.OpenFile(dump, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if e != nil {
				return m, "", e
			}
			_, e = io.Copy(out, archive)
			closeErr := out.Close()
			if e != nil {
				return m, "", e
			}
			if closeErr != nil {
				return m, "", closeErr
			}
		default:
			return m, "", errors.New("unexpected archive entry")
		}
	}
	// tar can stop at its footer before age's final authentication tag is read.
	tail, err := io.ReadAll(io.LimitReader(decrypted, 1025))
	if err != nil || len(tail) > 1024 {
		return m, "", errors.New("backup final authentication failed")
	}
	for _, b := range tail {
		if b != 0 {
			return m, "", errors.New("unexpected archive suffix")
		}
	}
	if len(seen) != 2 || m.Format != 1 || m.SnapshotAt.IsZero() || len(m.Migrations) == 0 || len(m.Tables) == 0 {
		return m, "", errors.New("incomplete backup")
	}
	file, err := os.Open(dump)
	if err != nil {
		return m, "", err
	}
	defer file.Close()
	h := sha256.New()
	if _, err = io.Copy(h, file); err != nil {
		return m, "", err
	}
	if hex.EncodeToString(h.Sum(nil)) != m.DumpSHA256 {
		return m, "", errors.New("backup digest mismatch")
	}
	return m, dump, nil
}
