package recovery

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"filippo.io/age"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBackupAuthenticationAndArchiveBoundaries(t *testing.T) {
	key, _ := age.GenerateX25519Identity()
	wrong, _ := age.GenerateX25519Identity()
	dir := t.TempDir()
	identity := filepath.Join(dir, "identity")
	wrongFile := filepath.Join(dir, "wrong")
	if err := os.WriteFile(identity, []byte(key.String()), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(wrongFile, []byte(wrong.String()), 0600); err != nil {
		t.Fatal(err)
	}
	dump := []byte("PGDMP-isolated-fixture")
	hash := sha256.Sum256(dump)
	manifest := Manifest{Format: 1, SnapshotAt: time.Now().UTC(), Tables: map[string]Table{"tasks": {1, "digest"}}, Migrations: map[string]string{"005": "checksum"}, DumpSHA256: hex.EncodeToString(hash[:])}
	makeArchive := func(name string) []byte {
		var encrypted bytes.Buffer
		w, err := age.Encrypt(&encrypted, key.Recipient())
		if err != nil {
			t.Fatal(err)
		}
		tw := tar.NewWriter(w)
		data, _ := json.Marshal(manifest)
		for _, entry := range []struct {
			name string
			data []byte
		}{{"manifest.json", data}, {name, dump}} {
			if err = tw.WriteHeader(&tar.Header{Name: entry.name, Size: int64(len(entry.data)), Mode: 0600}); err != nil {
				t.Fatal(err)
			}
			if _, err = tw.Write(entry.data); err != nil {
				t.Fatal(err)
			}
		}
		if err = tw.Close(); err != nil {
			t.Fatal(err)
		}
		if err = w.Close(); err != nil {
			t.Fatal(err)
		}
		return encrypted.Bytes()
	}
	valid := makeArchive("database.dump")
	for _, tc := range []struct {
		name     string
		data     []byte
		identity string
		valid    bool
	}{
		{"valid", valid, identity, true}, {"wrong identity", valid, wrongFile, false}, {"truncated", valid[:len(valid)-1], identity, false}, {"path traversal", makeArchive("../database.dump"), identity, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := filepath.Join(t.TempDir(), "backup.age")
			if err := os.WriteFile(input, tc.data, 0600); err != nil {
				t.Fatal(err)
			}
			_, _, err := Open(input, tc.identity, t.TempDir())
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v err=%v", tc.valid, err)
			}
		})
	}
	mutated := append([]byte(nil), valid...)
	mutated[len(mutated)/2] ^= 1
	input := filepath.Join(t.TempDir(), "tampered.age")
	_ = os.WriteFile(input, mutated, 0600)
	if _, _, err := Open(input, identity, t.TempDir()); err == nil {
		t.Fatal("authenticated stream accepted tampering")
	}
}
