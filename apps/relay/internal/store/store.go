package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

var (
	ErrNotFound     = errors.New("not found")
	ErrUnauthorized = errors.New("unauthorized")
	ErrExpired      = errors.New("expired")
	ErrUsed         = errors.New("already used")
)

type User struct {
	ID              string    `json:"id"`
	Email           string    `json:"email,omitempty"`
	IdentityIssuer  string    `json:"identity_issuer,omitempty"`
	IdentitySubject string    `json:"identity_subject,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
}

type Device struct {
	ID                 string     `json:"id"`
	InstallationID     string     `json:"installation_id,omitempty"`
	UserID             string     `json:"user_id"`
	Name               string     `json:"name"`
	ProofKeyThumbprint string     `json:"proof_key_thumbprint,omitempty"`
	CreatedAt          time.Time  `json:"created_at"`
	RevokedAt          *time.Time `json:"revoked_at,omitempty"`
}

type ManagedEndpoint struct {
	HTTPBaseURL  string `json:"http_base_url"`
	WSBaseURL    string `json:"ws_base_url"`
	ProviderKind string `json:"provider_kind"`
}

type ConnectLink struct {
	EnvironmentPublicKey string
	Endpoint             ManagedEndpoint
}

type Agent struct {
	ID                        string           `json:"id"`
	OwnerUserID               *string          `json:"owner_user_id,omitempty"`
	Name                      string           `json:"name"`
	Mode                      string           `json:"mode"`
	Status                    string           `json:"status"`
	LastSeenAt                *time.Time       `json:"last_seen_at,omitempty"`
	CreatedAt                 time.Time        `json:"created_at"`
	Endpoint                  *ManagedEndpoint `json:"endpoint,omitempty"`
	LinkedAt                  *time.Time       `json:"linked_at,omitempty"`
	EnvironmentPublicKey      string           `json:"-"`
	EnvironmentCredentialHash string           `json:"-"`
}

type Pairing struct {
	Code       string     `json:"code,omitempty"`
	AgentToken string     `json:"agent_token,omitempty"`
	AgentID    string     `json:"agent_id"`
	Name       string     `json:"name"`
	ExpiresAt  time.Time  `json:"expires_at"`
	UsedAt     *time.Time `json:"used_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
}

type Enrollment struct {
	Code      string     `json:"code,omitempty"`
	UserID    string     `json:"user_id,omitempty"`
	Name      string     `json:"name"`
	ExpiresAt time.Time  `json:"expires_at"`
	UsedAt    *time.Time `json:"used_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
}

type Auth struct {
	User   User   `json:"user"`
	Device Device `json:"device"`
}

type Store interface {
	Close()
	UpsertIdentity(ctx context.Context, issuer string, subject string, email string) (User, error)
	CreateDeviceToken(ctx context.Context, email string, deviceName string) (User, Device, string, error)
	AuthenticateDevice(ctx context.Context, token string) (Auth, error)
	UpsertDevice(ctx context.Context, userID string, deviceID string, name string, proofKeyThumbprint string) (Device, error)
	ListDevices(ctx context.Context, userID string) ([]Device, error)
	RevokeDevice(ctx context.Context, userID string, deviceID string) (Device, error)
	ConsumeDPoPProof(ctx context.Context, thumbprint string, jti string, issuedAt int64, expiresAt time.Time) (bool, error)
	PruneDPoPProofs(ctx context.Context, now time.Time) error
	AuthenticateCompanion(ctx context.Context, agentID string, token string) error
	AuthenticateEnvironment(ctx context.Context, agentID string, credential string) (Agent, error)
	UpsertAgent(ctx context.Context, agentID string, name string) (Agent, error)
	TouchAgent(ctx context.Context, agentID string, status string) error
	CreateEnrollment(ctx context.Context, userID string, name string, ttl time.Duration) (Enrollment, error)
	GetEnrollment(ctx context.Context, code string) (Enrollment, error)
	ClaimEnrollment(ctx context.Context, code string, agentID string, name string, link *ConnectLink) (Agent, string, string, error)
	CreatePairing(ctx context.Context, agentID string, name string, ttl time.Duration, companionToken string) (Pairing, error)
	RecoverPairing(ctx context.Context, userID string, agentID string, name string, ttl time.Duration) (Pairing, error)
	GetPairing(ctx context.Context, code string) (Pairing, error)
	ClaimPairing(ctx context.Context, code string, userID string) (Agent, error)
	ListAgents(ctx context.Context, userID string) ([]Agent, error)
	UserCanAccessAgent(ctx context.Context, userID string, agentID string) (bool, error)
	GetConnectEnvironment(ctx context.Context, userID string, agentID string) (Agent, error)
	UnlinkAgent(ctx context.Context, userID string, agentID string) (bool, error)
	UpdateConnectEndpoint(ctx context.Context, agentID string, endpoint ManagedEndpoint) error
	CountManagedEndpoints(ctx context.Context, userID string, excludingAgentID string) (int, error)
}

func IdentityUserID(issuer string, subject string) string {
	sum := sha256.Sum256([]byte(strings.TrimRight(strings.TrimSpace(issuer), "/") + "\x00" + strings.TrimSpace(subject)))
	return "usr_" + hex.EncodeToString(sum[:16])
}

func DeviceRecordID(userID string, installationID string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(userID) + "\x00" + strings.TrimSpace(installationID)))
	return "dev_" + hex.EncodeToString(sum[:16])
}

func HashSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

func RandomToken(bytes int) (string, error) {
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf), nil
}

func RandomCode(length int) string {
	token, err := RandomToken(length)
	if err != nil {
		panic("crypto/rand is unavailable: " + err.Error())
	}
	if len(token) > length {
		return token[:length]
	}
	return token
}
