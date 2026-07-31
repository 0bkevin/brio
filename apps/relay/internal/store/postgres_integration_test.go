package store

import (
	"os"
	"testing"
	"time"
)

func TestPostgresIdentityDeviceAndDPoPMigration(t *testing.T) {
	databaseURL := os.Getenv("BRIO_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("BRIO_TEST_DATABASE_URL is not set")
	}
	st, err := NewPostgresStore(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	user, err := st.UpsertIdentity(t.Context(), "https://clerk.example", "user-integration", "owner@example.com")
	if err != nil {
		t.Fatal(err)
	}
	device, err := st.UpsertDevice(t.Context(), user.ID, "installation-integration", "Test phone", "proof-thumbprint")
	if err != nil {
		t.Fatal(err)
	}
	if device.InstallationID != "installation-integration" || device.ProofKeyThumbprint != "proof-thumbprint" {
		t.Fatalf("unexpected device: %+v", device)
	}
	consumed, err := st.ConsumeDPoPProof(t.Context(), "proof-thumbprint", "proof-integration", time.Now().Unix(), time.Now().Add(time.Minute))
	if err != nil || !consumed {
		t.Fatalf("first DPoP consume: consumed=%v err=%v", consumed, err)
	}
	consumed, err = st.ConsumeDPoPProof(t.Context(), "proof-thumbprint", "proof-integration", time.Now().Unix(), time.Now().Add(time.Minute))
	if err != nil || consumed {
		t.Fatalf("replayed DPoP consume: consumed=%v err=%v", consumed, err)
	}
}
