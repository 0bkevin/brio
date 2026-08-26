package cli

import "testing"

func TestShouldProbeTunnelSkipsActiveService(t *testing.T) {
	if shouldProbeTunnel("active") {
		t.Fatal("active service must not be displaced by a credential probe")
	}
	for _, state := range []string{"", "inactive", "failed", "unknown"} {
		if !shouldProbeTunnel(state) {
			t.Fatalf("service state %q should allow a credential probe", state)
		}
	}
}
