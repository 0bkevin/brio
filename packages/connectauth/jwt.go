// Package connectauth implements the small ES256/JWK profile shared by the
// Brio Connect control plane and companion. It deliberately avoids a general
// JWT dependency so the accepted algorithms and claims stay explicit.
package connectauth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"
)

var rawURL = base64.RawURLEncoding

type JWK struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

type Claims struct {
	Issuer   string          `json:"iss"`
	Audience string          `json:"aud"`
	Subject  string          `json:"sub"`
	ID       string          `json:"jti"`
	IssuedAt int64           `json:"iat"`
	Expires  int64           `json:"exp"`
	Extra    json.RawMessage `json:"-"`
}

type VerifiedToken struct {
	Header map[string]any
	Claims map[string]any
}

func GeneratePrivateKey() (*ecdsa.PrivateKey, error) {
	return ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
}

func EncodePrivateKey(key *ecdsa.PrivateKey) (string, error) {
	encoded, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded})), nil
}

func DecodePrivateKey(encoded string) (*ecdsa.PrivateKey, error) {
	encoded = strings.ReplaceAll(encoded, `\n`, "\n")
	block, _ := pem.Decode([]byte(encoded))
	if block == nil {
		return nil, errors.New("invalid private key PEM")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	privateKey, ok := key.(*ecdsa.PrivateKey)
	if !ok || privateKey.Curve != elliptic.P256() {
		return nil, errors.New("private key must be P-256")
	}
	return privateKey, nil
}

func PublicJWK(key *ecdsa.PublicKey) JWK {
	size := (key.Curve.Params().BitSize + 7) / 8
	x := key.X.FillBytes(make([]byte, size))
	y := key.Y.FillBytes(make([]byte, size))
	return JWK{Kty: "EC", Crv: "P-256", X: rawURL.EncodeToString(x), Y: rawURL.EncodeToString(y)}
}

func ParsePublicJWK(jwk JWK) (*ecdsa.PublicKey, error) {
	if jwk.Kty != "EC" || jwk.Crv != "P-256" || jwk.X == "" || jwk.Y == "" {
		return nil, errors.New("JWK must be an EC P-256 public key")
	}
	xBytes, err := rawURL.DecodeString(jwk.X)
	if err != nil {
		return nil, errors.New("invalid JWK x coordinate")
	}
	yBytes, err := rawURL.DecodeString(jwk.Y)
	if err != nil {
		return nil, errors.New("invalid JWK y coordinate")
	}
	key := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(xBytes), Y: new(big.Int).SetBytes(yBytes)}
	if !key.Curve.IsOnCurve(key.X, key.Y) {
		return nil, errors.New("JWK point is not on P-256")
	}
	return key, nil
}

func Thumbprint(jwk JWK) (string, error) {
	if _, err := ParsePublicJWK(jwk); err != nil {
		return "", err
	}
	canonical := fmt.Sprintf(`{"crv":"P-256","kty":"EC","x":"%s","y":"%s"}`, jwk.X, jwk.Y)
	sum := sha256.Sum256([]byte(canonical))
	return rawURL.EncodeToString(sum[:]), nil
}

func EncodeJWK(jwk JWK) string {
	data, _ := json.Marshal(jwk)
	return string(data)
}

func DecodeJWK(encoded string) (JWK, error) {
	var jwk JWK
	if err := json.Unmarshal([]byte(encoded), &jwk); err != nil {
		return JWK{}, err
	}
	if _, err := ParsePublicJWK(jwk); err != nil {
		return JWK{}, err
	}
	return jwk, nil
}

func Sign(key *ecdsa.PrivateKey, typ string, claims map[string]any) (string, error) {
	header, err := json.Marshal(map[string]any{"alg": "ES256", "typ": typ, "jwk": PublicJWK(&key.PublicKey)})
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	input := rawURL.EncodeToString(header) + "." + rawURL.EncodeToString(payload)
	digest := sha256.Sum256([]byte(input))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		return "", err
	}
	signature := append(r.FillBytes(make([]byte, 32)), s.FillBytes(make([]byte, 32))...)
	return input + "." + rawURL.EncodeToString(signature), nil
}

func DecodeUnverified(token string) (map[string]any, map[string]any, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, nil, errors.New("token must have three parts")
	}
	headerBytes, err := rawURL.DecodeString(parts[0])
	if err != nil {
		return nil, nil, errors.New("invalid token header")
	}
	payloadBytes, err := rawURL.DecodeString(parts[1])
	if err != nil {
		return nil, nil, errors.New("invalid token payload")
	}
	var header, claims map[string]any
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		return nil, nil, errors.New("invalid token header JSON")
	}
	if err := json.Unmarshal(payloadBytes, &claims); err != nil {
		return nil, nil, errors.New("invalid token claims JSON")
	}
	return header, claims, nil
}

func Verify(token string, key *ecdsa.PublicKey, typ, issuer, audience string, now time.Time) (VerifiedToken, error) {
	verified, err := VerifySigned(token, key, typ)
	if err != nil {
		return VerifiedToken{}, err
	}
	claims := verified.Claims
	if issuer != "" && stringClaim(claims, "iss") != issuer {
		return VerifiedToken{}, errors.New("token issuer is invalid")
	}
	if audience != "" && stringClaim(claims, "aud") != audience {
		return VerifiedToken{}, errors.New("token audience is invalid")
	}
	issuedAt, ok := numberClaim(claims, "iat")
	if !ok || issuedAt > now.Add(time.Minute).Unix() {
		return VerifiedToken{}, errors.New("token issued-at time is invalid")
	}
	expires, ok := numberClaim(claims, "exp")
	if !ok || expires <= now.Unix() {
		return VerifiedToken{}, errors.New("token is expired")
	}
	if stringClaim(claims, "jti") == "" || stringClaim(claims, "sub") == "" {
		return VerifiedToken{}, errors.New("token is missing required claims")
	}
	return verified, nil
}

// VerifySigned checks only the compact-JWS signature and protected header.
// Callers use it for DPoP proofs, whose registered claims differ from access
// tokens and are validated against the concrete HTTP request.
func VerifySigned(token string, key *ecdsa.PublicKey, typ string) (VerifiedToken, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return VerifiedToken{}, errors.New("token must have three parts")
	}
	header, claims, err := DecodeUnverified(token)
	if err != nil {
		return VerifiedToken{}, err
	}
	if header["alg"] != "ES256" || header["typ"] != typ {
		return VerifiedToken{}, errors.New("unexpected token algorithm or type")
	}
	signature, err := rawURL.DecodeString(parts[2])
	if err != nil || len(signature) != 64 {
		return VerifiedToken{}, errors.New("invalid ES256 signature")
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(key, digest[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:])) {
		return VerifiedToken{}, errors.New("token signature is invalid")
	}
	return VerifiedToken{Header: header, Claims: claims}, nil
}

func StringClaim(claims map[string]any, name string) string { return stringClaim(claims, name) }

func Int64Claim(claims map[string]any, name string) (int64, bool) { return numberClaim(claims, name) }

func stringClaim(claims map[string]any, name string) string {
	value, _ := claims[name].(string)
	return value
}

func numberClaim(claims map[string]any, name string) (int64, bool) {
	switch value := claims[name].(type) {
	case float64:
		return int64(value), value == float64(int64(value))
	case json.Number:
		parsed, err := value.Int64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return rawURL.EncodeToString(sum[:])
}

func RandomToken(bytes int) (string, error) {
	value := make([]byte, bytes)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return rawURL.EncodeToString(value), nil
}
