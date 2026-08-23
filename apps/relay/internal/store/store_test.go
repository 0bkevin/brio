package store

import (
	"errors"
	"testing"
)

type failingRandomReader struct{}

func (failingRandomReader) Read([]byte) (int, error) {
	return 0, errors.New("entropy unavailable")
}

func TestMustRandomCodeFailsClosedWhenEntropyIsUnavailable(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("mustRandomCode returned a predictable credential instead of failing closed")
		}
	}()
	_ = mustRandomCode(failingRandomReader{}, 8)
}

func TestRandomTokenRejectsNonPositiveSize(t *testing.T) {
	if _, err := RandomToken(0); err == nil {
		t.Fatal("RandomToken accepted a zero-sized credential")
	}
}

func TestPostgresMigrationsAreOrderedAndComplete(t *testing.T) {
	if err := validatePostgresMigrations(postgresMigrations); err != nil {
		t.Fatalf("repository migrations are invalid: %v", err)
	}
	invalid := append([]postgresMigration(nil), postgresMigrations...)
	invalid = append(invalid, postgresMigration{version: invalid[len(invalid)-1].version, name: "duplicate", sql: "SELECT 1"})
	if err := validatePostgresMigrations(invalid); err == nil {
		t.Fatal("duplicate migration version was accepted")
	}
}
