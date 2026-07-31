package auth

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/brio/brio/packages/connectauth"
)

var ErrInvalidDPoPProof = errors.New("invalid DPoP proof")

type ReplayStore interface {
	ConsumeDPoPProof(context.Context, string, string, int64, time.Time) (bool, error)
}

type DPoPResult struct {
	Thumbprint string
	JTI        string
	IssuedAt   int64
}

func VerifyAndConsumeDPoP(ctx context.Context, replay ReplayStore, proof, method, target string, expectedThumbprint string, expectedAccessToken string, now time.Time) (DPoPResult, error) {
	proof = strings.TrimSpace(proof)
	if len(proof) == 0 || len(proof) > 16<<10 {
		return DPoPResult{}, ErrInvalidDPoPProof
	}
	header, _, err := connectauth.DecodeUnverified(proof)
	if err != nil || header["alg"] != "ES256" || header["typ"] != "dpop+jwt" {
		return DPoPResult{}, ErrInvalidDPoPProof
	}
	jwk, err := claimAs[connectauth.JWK](header, "jwk")
	if err != nil {
		return DPoPResult{}, ErrInvalidDPoPProof
	}
	thumbprint, err := connectauth.Thumbprint(jwk)
	if err != nil || (expectedThumbprint != "" && thumbprint != expectedThumbprint) {
		return DPoPResult{}, ErrInvalidDPoPProof
	}
	publicKey, err := connectauth.ParsePublicJWK(jwk)
	if err != nil {
		return DPoPResult{}, ErrInvalidDPoPProof
	}
	verified, err := connectauth.VerifySigned(proof, publicKey, "dpop+jwt")
	if err != nil {
		return DPoPResult{}, ErrInvalidDPoPProof
	}
	issuedAt, ok := connectauth.Int64Claim(verified.Claims, "iat")
	nowUnix := now.Unix()
	if !ok || issuedAt > nowUnix+5 || issuedAt < nowUnix-300 {
		return DPoPResult{}, ErrInvalidDPoPProof
	}
	jti := strings.TrimSpace(connectauth.StringClaim(verified.Claims, "jti"))
	if jti == "" || len(jti) > 128 || !strings.EqualFold(connectauth.StringClaim(verified.Claims, "htm"), method) {
		return DPoPResult{}, ErrInvalidDPoPProof
	}
	if normalizeHTU(connectauth.StringClaim(verified.Claims, "htu")) != normalizeHTU(target) {
		return DPoPResult{}, ErrInvalidDPoPProof
	}
	if expectedAccessToken != "" && connectauth.StringClaim(verified.Claims, "ath") != connectauth.HashToken(expectedAccessToken) {
		return DPoPResult{}, ErrInvalidDPoPProof
	}
	if expectedAccessToken == "" && connectauth.StringClaim(verified.Claims, "ath") != "" {
		return DPoPResult{}, ErrInvalidDPoPProof
	}
	consumed, err := replay.ConsumeDPoPProof(ctx, thumbprint, jti, issuedAt, now.Add(5*time.Minute))
	if err != nil {
		return DPoPResult{}, err
	}
	if !consumed {
		return DPoPResult{}, ErrInvalidDPoPProof
	}
	return DPoPResult{Thumbprint: thumbprint, JTI: jti, IssuedAt: issuedAt}, nil
}

func normalizeHTU(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil {
		return ""
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	return parsed.String()
}
