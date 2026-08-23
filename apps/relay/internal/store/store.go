package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
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
	ID        string     `json:"id"`
	UserID    string     `json:"user_id"`
	Name      string     `json:"name"`
	CreatedAt time.Time  `json:"created_at"`
	RevokedAt *time.Time `json:"revoked_at,omitempty"`
}

type Agent struct {
	ID          string     `json:"id"`
	OwnerUserID *string    `json:"owner_user_id,omitempty"`
	Name        string     `json:"name"`
	Mode        string     `json:"mode"`
	Status      string     `json:"status"`
	LastSeenAt  *time.Time `json:"last_seen_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
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
	CreateDeviceTokenForUser(ctx context.Context, userID string, deviceName string) (User, Device, string, error)
	AuthenticateDevice(ctx context.Context, token string) (Auth, error)
	ListDevices(ctx context.Context, userID string) ([]Device, error)
	RevokeDevice(ctx context.Context, userID string, deviceID string) (Device, error)
	AuthenticateCompanion(ctx context.Context, agentID string, token string) error
	UpsertAgent(ctx context.Context, agentID string, name string) (Agent, error)
	TouchAgent(ctx context.Context, agentID string, status string) error
	CreateEnrollment(ctx context.Context, userID string, name string, ttl time.Duration) (Enrollment, error)
	ClaimEnrollment(ctx context.Context, code string, agentID string, name string) (Agent, string, error)
	CreatePairing(ctx context.Context, agentID string, name string, ttl time.Duration, companionToken string) (Pairing, error)
	RecoverPairing(ctx context.Context, userID string, agentID string, name string, ttl time.Duration) (Pairing, error)
	GetPairing(ctx context.Context, code string) (Pairing, error)
	ClaimPairing(ctx context.Context, code string, userID string) (Agent, error)
	ListAgents(ctx context.Context, userID string) ([]Agent, error)
	UnlinkAgent(ctx context.Context, userID string, agentID string) (Agent, error)
	UserCanAccessAgent(ctx context.Context, userID string, agentID string) (bool, error)
}

func IdentityUserID(issuer string, subject string) string {
	issuer = strings.TrimRight(strings.TrimSpace(issuer), "/")
	subject = strings.TrimSpace(subject)
	sum := sha256.Sum256([]byte(issuer + "\x00" + subject))
	return "usr_" + hex.EncodeToString(sum[:16])
}

func HashSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

func RandomToken(bytes int) (string, error) {
	return randomToken(rand.Reader, bytes)
}

func randomToken(reader io.Reader, bytes int) (string, error) {
	if bytes <= 0 {
		return "", errors.New("random token size must be positive")
	}
	buf := make([]byte, bytes)
	if _, err := io.ReadFull(reader, buf); err != nil {
		return "", err
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf), nil
}

func RandomCode(length int) string {
	return mustRandomCode(rand.Reader, length)
}

func mustRandomCode(reader io.Reader, length int) string {
	token, err := randomToken(reader, length)
	if err != nil {
		panic(fmt.Errorf("generate cryptographically secure random code: %w", err))
	}
	if len(token) > length {
		return token[:length]
	}
	return token
}
