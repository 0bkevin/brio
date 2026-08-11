package cli

import "testing"

func TestPublicURLFromAddr(t *testing.T) {
	tests := []struct {
		name string
		addr string
		want string
	}{
		{name: "loopback", addr: "127.0.0.1:8787", want: "http://127.0.0.1:8787"},
		{name: "opaque fallback", addr: "localhost", want: "http://localhost"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := publicURLFromAddr(tt.addr); got != tt.want {
				t.Fatalf("publicURLFromAddr(%q) = %q, want %q", tt.addr, got, tt.want)
			}
		})
	}
}

func TestPublicURLFromWildcardAddrUsesReachableHost(t *testing.T) {
	tests := []struct {
		name string
		addr string
		want string
	}{
		{name: "wildcard ipv4", addr: "0.0.0.0:8787", want: "http://192.168.1.25:8787"},
		{name: "wildcard ipv6", addr: "[::]:8787", want: "http://192.168.1.25:8787"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := publicURLFromAddrWithWildcardHost(tt.addr, "192.168.1.25"); got != tt.want {
				t.Fatalf("publicURLFromAddrWithWildcardHost(%q) = %q, want %q", tt.addr, got, tt.want)
			}
		})
	}
}
