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
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	CreatedAt time.Time `json:"created_at"`
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

type Auth struct {
	User   User   `json:"user"`
	Device Device `json:"device"`
}

type Store interface {
	Close()
	CreateDeviceToken(ctx context.Context, email string, deviceName string) (User, Device, string, error)
	AuthenticateDevice(ctx context.Context, token string) (Auth, error)
	AuthenticateCompanion(ctx context.Context, agentID string, token string) error
	UpsertAgent(ctx context.Context, agentID string, name string) (Agent, error)
	TouchAgent(ctx context.Context, agentID string, status string) error
	CreatePairing(ctx context.Context, agentID string, name string, ttl time.Duration) (Pairing, error)
	GetPairing(ctx context.Context, code string) (Pairing, error)
	ClaimPairing(ctx context.Context, code string, userID string) (Agent, error)
	ListAgents(ctx context.Context, userID string) ([]Agent, error)
	UserCanAccessAgent(ctx context.Context, userID string, agentID string) (bool, error)
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
		return strings.Repeat("A", length)
	}
	if len(token) > length {
		return token[:length]
	}
	return token
}
