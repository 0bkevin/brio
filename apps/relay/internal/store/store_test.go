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
