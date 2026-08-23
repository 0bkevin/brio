package server

import (
	"fmt"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxRateLimitKeys = 50_000

type rateLimitPolicy struct {
	limit  int
	window time.Duration
}

var relayRateLimitPolicies = map[string]rateLimitPolicy{
	"device-registration": {limit: 10, window: 10 * time.Minute},
	"enrollment-create":   {limit: 30, window: time.Minute},
	"enrollment-claim":    {limit: 12, window: time.Minute},
	"agent-recovery":      {limit: 10, window: 10 * time.Minute},
	"pairing-create":      {limit: 20, window: time.Minute},
	"pairing-read":        {limit: 30, window: time.Minute},
	"pairing-claim":       {limit: 12, window: time.Minute},
	"tunnel-auth":         {limit: 120, window: time.Minute},
}

type fixedWindowEntry struct {
	count   int
	resetAt time.Time
}

type fixedWindowLimiter struct {
	mu        sync.Mutex
	limit     int
	window    time.Duration
	entries   map[string]fixedWindowEntry
	lastSweep time.Time
}

func newRelayRateLimiters() map[string]*fixedWindowLimiter {
	limiters := make(map[string]*fixedWindowLimiter, len(relayRateLimitPolicies))
	for name, policy := range relayRateLimitPolicies {
		limiters[name] = &fixedWindowLimiter{
			limit:   policy.limit,
			window:  policy.window,
			entries: map[string]fixedWindowEntry{},
		}
	}
	return limiters
}

func (l *fixedWindowLimiter) allow(key string, now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.lastSweep.IsZero() || now.Sub(l.lastSweep) >= l.window {
		for existingKey, entry := range l.entries {
			if !now.Before(entry.resetAt) {
				delete(l.entries, existingKey)
			}
		}
		l.lastSweep = now
	}

	entry, exists := l.entries[key]
	if !exists || !now.Before(entry.resetAt) {
		if !exists && len(l.entries) >= maxRateLimitKeys {
			return false, l.window
		}
		l.entries[key] = fixedWindowEntry{count: 1, resetAt: now.Add(l.window)}
		return true, 0
	}
	if entry.count >= l.limit {
		return false, entry.resetAt.Sub(now)
	}
	entry.count++
	l.entries[key] = entry
	return true, 0
}

func (a *app) rateLimit(policyName string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limiter := a.rateLimiters[policyName]
		if limiter == nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "rate limit policy is not configured"})
			return
		}
		allowed, retryAfter := limiter.allow(a.clientIP(r), time.Now().UTC())
		if !allowed {
			seconds := int(math.Ceil(retryAfter.Seconds()))
			if seconds < 1 {
				seconds = 1
			}
			w.Header().Set("Retry-After", strconv.Itoa(seconds))
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "too many requests"})
			return
		}
		next(w, r)
	}
}

type trustedProxySet []*net.IPNet

func parseTrustedProxyCIDRs(values []string) (trustedProxySet, error) {
	proxies := make(trustedProxySet, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		_, network, err := net.ParseCIDR(value)
		if err != nil {
			return nil, fmt.Errorf("invalid trusted proxy CIDR %q: %w", value, err)
		}
		proxies = append(proxies, network)
	}
	return proxies, nil
}

func (s trustedProxySet) contains(ip net.IP) bool {
	if ip == nil {
		return false
	}
	for _, network := range s {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

func (a *app) clientIP(r *http.Request) string {
	directIP := remoteIP(r.RemoteAddr)
	if !a.trustedProxies.contains(directIP) {
		return normalizedIP(directIP)
	}

	forwarded := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for index := len(forwarded) - 1; index >= 0; index-- {
		candidate := net.ParseIP(strings.TrimSpace(forwarded[index]))
		if candidate != nil && !a.trustedProxies.contains(candidate) {
			return normalizedIP(candidate)
		}
	}
	return normalizedIP(directIP)
}

func (a *app) requireSecureTransport(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.cfg.InsecureDevMode || r.URL.Path == "/health" || a.requestUsesSecureTransport(r) {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Upgrade", "TLS/1.2, HTTP/1.1")
		writeJSON(w, http.StatusUpgradeRequired, map[string]any{
			"error": "HTTPS/WSS is required outside loopback",
		})
	})
}

func (a *app) requestUsesSecureTransport(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	directIP := remoteIP(r.RemoteAddr)
	if directIP != nil && directIP.IsLoopback() {
		return true
	}
	if !a.trustedProxies.contains(directIP) {
		return false
	}
	forwardedProto := r.Header.Get("X-Forwarded-Proto")
	parts := strings.Split(forwardedProto, ",")
	return len(parts) > 0 && strings.EqualFold(strings.TrimSpace(parts[len(parts)-1]), "https")
}

func remoteIP(remoteAddr string) net.IP {
	host, _, err := net.SplitHostPort(strings.TrimSpace(remoteAddr))
	if err == nil {
		return net.ParseIP(host)
	}
	return net.ParseIP(strings.Trim(strings.TrimSpace(remoteAddr), "[]"))
}

func normalizedIP(ip net.IP) string {
	if ip == nil {
		return "unknown"
	}
	return ip.String()
}
