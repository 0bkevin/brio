package server

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestFixedWindowLimiterBlocksAndResets(t *testing.T) {
	now := time.Date(2026, time.August, 23, 12, 0, 0, 0, time.UTC)
	limiter := &fixedWindowLimiter{limit: 2, window: time.Minute, entries: map[string]fixedWindowEntry{}}
	for attempt := 0; attempt < 2; attempt++ {
		if allowed, _ := limiter.allow("client", now); !allowed {
			t.Fatalf("attempt %d was unexpectedly blocked", attempt+1)
		}
	}
	if allowed, retry := limiter.allow("client", now); allowed || retry <= 0 {
		t.Fatalf("third attempt = allowed %v retry %v, want blocked", allowed, retry)
	}
	if allowed, _ := limiter.allow("client", now.Add(time.Minute)); !allowed {
		t.Fatal("first attempt after reset was blocked")
	}
}

func TestRateLimitMiddlewareReturnsRetryAfter(t *testing.T) {
	a := &app{rateLimiters: map[string]*fixedWindowLimiter{
		"test": {limit: 1, window: time.Minute, entries: map[string]fixedWindowEntry{}},
	}}
	called := 0
	handler := a.rateLimit("test", func(w http.ResponseWriter, r *http.Request) {
		called++
		w.WriteHeader(http.StatusNoContent)
	})

	for attempt := 0; attempt < 2; attempt++ {
		req := httptest.NewRequest(http.MethodPost, "/auth/devices", nil)
		req.RemoteAddr = "198.51.100.10:4321"
		recorder := httptest.NewRecorder()
		handler(recorder, req)
		if attempt == 0 && recorder.Code != http.StatusNoContent {
			t.Fatalf("first status = %d", recorder.Code)
		}
		if attempt == 1 {
			if recorder.Code != http.StatusTooManyRequests {
				t.Fatalf("limited status = %d, want %d", recorder.Code, http.StatusTooManyRequests)
			}
			if recorder.Header().Get("Retry-After") == "" {
				t.Fatal("rate-limited response omitted Retry-After")
			}
		}
	}
	if called != 1 {
		t.Fatalf("handler calls = %d, want 1", called)
	}
}

func TestClientIPTrustsForwardingOnlyFromConfiguredProxy(t *testing.T) {
	trusted, err := parseTrustedProxyCIDRs([]string{"10.0.0.0/8", "2001:db8:1::/48"})
	if err != nil {
		t.Fatal(err)
	}
	a := &app{trustedProxies: trusted}

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "203.0.113.8:1234"
	req.Header.Set("X-Forwarded-For", "198.51.100.9")
	if got := a.clientIP(req); got != "203.0.113.8" {
		t.Fatalf("untrusted proxy client IP = %q", got)
	}

	req.RemoteAddr = "10.1.2.3:1234"
	req.Header.Set("X-Forwarded-For", "198.51.100.9, 10.9.8.7")
	if got := a.clientIP(req); got != "198.51.100.9" {
		t.Fatalf("trusted proxy chain client IP = %q", got)
	}
}

func TestParseTrustedProxyCIDRsRejectsInvalidValue(t *testing.T) {
	if _, err := parseTrustedProxyCIDRs([]string{"not-a-network"}); err == nil {
		t.Fatal("invalid trusted proxy CIDR was accepted")
	}
}

func TestSecureTransportRejectsPlaintextOutsideLoopback(t *testing.T) {
	a := &app{}
	called := false
	handler := a.requireSecureTransport(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodPost, "/auth/devices", nil)
	req.RemoteAddr = "203.0.113.8:1234"
	req.Header.Set("X-Forwarded-Proto", "https")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, req)

	if called {
		t.Fatal("untrusted plaintext request reached the handler")
	}
	if recorder.Code != http.StatusUpgradeRequired {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusUpgradeRequired)
	}
}

func TestSecureTransportAcceptsTLSLoopbackAndTrustedTLSProxy(t *testing.T) {
	trusted, err := parseTrustedProxyCIDRs([]string{"10.0.0.0/8"})
	if err != nil {
		t.Fatal(err)
	}
	a := &app{trustedProxies: trusted}
	handler := a.requireSecureTransport(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	tests := []struct {
		name       string
		remoteAddr string
		tls        bool
		proto      string
	}{
		{name: "direct TLS", remoteAddr: "203.0.113.8:1234", tls: true},
		{name: "loopback HTTP", remoteAddr: "127.0.0.1:1234"},
		{name: "trusted TLS proxy", remoteAddr: "10.1.2.3:1234", proto: "https"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/auth/devices", nil)
			req.RemoteAddr = test.remoteAddr
			if test.tls {
				req.TLS = &tls.ConnectionState{}
			}
			if test.proto != "" {
				req.Header.Set("X-Forwarded-Proto", test.proto)
			}
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, req)
			if recorder.Code != http.StatusNoContent {
				t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNoContent)
			}
		})
	}
}

func TestSecureTransportAllowsHealthProbe(t *testing.T) {
	a := &app{}
	handler := a.requireSecureTransport(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.RemoteAddr = "203.0.113.8:1234"
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("health status = %d, want %d", recorder.Code, http.StatusNoContent)
	}
}
