//go:build linux

package cli

import (
	"strings"
	"testing"
)

func TestRenderSystemdUserServiceBoundsCrashLoopsAndChildOOMs(t *testing.T) {
	unit := renderSystemdUserService(`/opt/Brio Connector/brio`, `/home/brio user`)
	for _, expected := range []string{
		"StartLimitIntervalSec=300",
		"StartLimitBurst=5",
		"OOMPolicy=continue",
		"Restart=always",
		"RestartSec=5",
		`ExecStart="/opt/Brio Connector/brio" connect`,
		`WorkingDirectory="/home/brio user"`,
	} {
		if !strings.Contains(unit, expected) {
			t.Fatalf("systemd unit omitted %q:\n%s", expected, unit)
		}
	}
}
