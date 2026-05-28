package store

import (
	"context"
	"strings"
	"sync"
	"time"
)

type MemoryStore struct {
	mu          sync.Mutex
	users       map[string]User
	userByEmail map[string]string
	devices     map[string]Device
	deviceToken map[string]string
	agents      map[string]Agent
	agentToken  map[string]string
	pairings    map[string]Pairing
	enrollments map[string]Enrollment
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		users:       map[string]User{},
		userByEmail: map[string]string{},
		devices:     map[string]Device{},
		deviceToken: map[string]string{},
		agents:      map[string]Agent{},
		agentToken:  map[string]string{},
		pairings:    map[string]Pairing{},
		enrollments: map[string]Enrollment{},
	}
}

func (s *MemoryStore) Close() {}

func (s *MemoryStore) CreateDeviceToken(ctx context.Context, email string, deviceName string) (User, Device, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		email = "dev@brio.local"
	}
	if deviceName == "" {
		deviceName = "Development device"
	}
	userID := s.userByEmail[email]
	if userID == "" {
		userID = "usr_" + RandomCode(20)
		s.users[userID] = User{ID: userID, Email: email, CreatedAt: time.Now().UTC()}
		s.userByEmail[email] = userID
	}
	deviceID := "dev_" + RandomCode(20)
	token := "brio_dev_" + RandomCode(40)
	device := Device{ID: deviceID, UserID: userID, Name: deviceName, CreatedAt: time.Now().UTC()}
	s.devices[deviceID] = device
	s.deviceToken[HashSecret(token)] = deviceID
	return s.users[userID], device, token, nil
}

func (s *MemoryStore) AuthenticateDevice(ctx context.Context, token string) (Auth, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	deviceID := s.deviceToken[HashSecret(token)]
	device, ok := s.devices[deviceID]
	if !ok || device.RevokedAt != nil {
		return Auth{}, ErrUnauthorized
	}
	user, ok := s.users[device.UserID]
	if !ok {
		return Auth{}, ErrUnauthorized
	}
	return Auth{User: user, Device: device}, nil
}

func (s *MemoryStore) ListDevices(ctx context.Context, userID string) ([]Device, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Device{}
	for _, device := range s.devices {
		if device.UserID == userID {
			out = append(out, device)
		}
	}
	return out, nil
}

func (s *MemoryStore) RevokeDevice(ctx context.Context, userID string, deviceID string) (Device, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	device, ok := s.devices[deviceID]
	if !ok {
		return Device{}, ErrNotFound
	}
	if device.UserID != userID {
		return Device{}, ErrUnauthorized
	}
	now := time.Now().UTC()
	device.RevokedAt = &now
	s.devices[deviceID] = device
	return device, nil
}

func (s *MemoryStore) AuthenticateCompanion(ctx context.Context, agentID string, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if token == "" || s.agentToken[agentID] != HashSecret(token) {
		return ErrUnauthorized
	}
	return nil
}

func (s *MemoryStore) UpsertAgent(ctx context.Context, agentID string, name string) (Agent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if name == "" {
		name = "Hermes"
	}
	agent := s.agents[agentID]
	if agent.ID == "" {
		agent = Agent{ID: agentID, Name: name, Mode: "self_hosted", Status: "offline", CreatedAt: time.Now().UTC()}
	} else {
		agent.Name = name
	}
	s.agents[agentID] = agent
	return agent, nil
}

func (s *MemoryStore) TouchAgent(ctx context.Context, agentID string, status string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent := s.agents[agentID]
	if agent.ID == "" {
		agent = Agent{ID: agentID, Name: "Hermes", Mode: "self_hosted", CreatedAt: time.Now().UTC()}
	}
	now := time.Now().UTC()
	agent.Status = status
	agent.LastSeenAt = &now
	s.agents[agentID] = agent
	return nil
}

func (s *MemoryStore) CreateEnrollment(ctx context.Context, userID string, name string, ttl time.Duration) (Enrollment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if name == "" {
		name = "Hermes"
	}
	now := time.Now().UTC()
	enrollment := Enrollment{
		Code:      RandomCode(8),
		UserID:    userID,
		Name:      name,
		ExpiresAt: now.Add(ttl),
		CreatedAt: now,
	}
	s.enrollments[HashSecret(enrollment.Code)] = enrollment
	return enrollment, nil
}

func (s *MemoryStore) ClaimEnrollment(ctx context.Context, code string, agentID string, name string) (Agent, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := HashSecret(strings.ToUpper(strings.TrimSpace(code)))
	enrollment, ok := s.enrollments[key]
	if !ok {
		return Agent{}, "", ErrNotFound
	}
	if time.Now().After(enrollment.ExpiresAt) {
		return Agent{}, "", ErrExpired
	}
	if enrollment.UsedAt != nil {
		return Agent{}, "", ErrUsed
	}
	if name == "" {
		name = enrollment.Name
	}
	agent := s.agents[agentID]
	if agent.ID != "" && agent.OwnerUserID != nil && *agent.OwnerUserID != enrollment.UserID {
		return Agent{}, "", ErrUnauthorized
	}
	now := time.Now().UTC()
	agent.OwnerUserID = &enrollment.UserID
	agent.ID = agentID
	agent.Name = name
	agent.Mode = "self_hosted"
	agent.Status = "online"
	agent.LastSeenAt = &now
	if agent.CreatedAt.IsZero() {
		agent.CreatedAt = now
	}
	s.agents[agentID] = agent
	enrollment.UsedAt = &now
	s.enrollments[key] = enrollment
	token := "brio_agent_" + RandomCode(48)
	s.agentToken[agentID] = HashSecret(token)
	return agent, token, nil
}

func (s *MemoryStore) CreatePairing(ctx context.Context, agentID string, name string, ttl time.Duration, companionToken string) (Pairing, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if name == "" {
		name = "Hermes"
	}
	agent := s.agents[agentID]
	if agent.ID == "" {
		agent = Agent{ID: agentID, Name: name, Mode: "self_hosted", Status: "online", CreatedAt: time.Now().UTC()}
	} else {
		if agent.OwnerUserID != nil && (companionToken == "" || s.agentToken[agentID] != HashSecret(companionToken)) {
			return Pairing{}, ErrUnauthorized
		}
		agent.Name = name
	}
	now := time.Now().UTC()
	agent.Status = "online"
	agent.LastSeenAt = &now
	s.agents[agentID] = agent
	code := RandomCode(8)
	agentToken := "brio_agent_" + RandomCode(48)
	s.agentToken[agentID] = HashSecret(agentToken)
	p := Pairing{Code: code, AgentToken: agentToken, AgentID: agentID, Name: name, ExpiresAt: now.Add(ttl), CreatedAt: now}
	s.pairings[HashSecret(code)] = p
	return p, nil
}

func (s *MemoryStore) RecoverPairing(ctx context.Context, userID string, agentID string, name string, ttl time.Duration) (Pairing, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent := s.agents[agentID]
	if agent.ID == "" {
		return Pairing{}, ErrNotFound
	}
	if agent.OwnerUserID == nil || *agent.OwnerUserID != userID {
		return Pairing{}, ErrUnauthorized
	}
	if name == "" {
		name = agent.Name
	}
	agent.Name = name
	now := time.Now().UTC()
	agent.Status = "online"
	agent.LastSeenAt = &now
	s.agents[agentID] = agent
	code := RandomCode(8)
	agentToken := "brio_agent_" + RandomCode(48)
	s.agentToken[agentID] = HashSecret(agentToken)
	p := Pairing{Code: code, AgentToken: agentToken, AgentID: agentID, Name: name, ExpiresAt: now.Add(ttl), CreatedAt: now}
	s.pairings[HashSecret(code)] = p
	return p, nil
}

func (s *MemoryStore) GetPairing(ctx context.Context, code string) (Pairing, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.pairings[HashSecret(strings.ToUpper(strings.TrimSpace(code)))]
	if !ok {
		return Pairing{}, ErrNotFound
	}
	if time.Now().After(p.ExpiresAt) {
		return Pairing{}, ErrExpired
	}
	if p.UsedAt != nil {
		return Pairing{}, ErrUsed
	}
	p.AgentToken = ""
	return p, nil
}

func (s *MemoryStore) ClaimPairing(ctx context.Context, code string, userID string) (Agent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := HashSecret(strings.ToUpper(strings.TrimSpace(code)))
	p, ok := s.pairings[key]
	if !ok {
		return Agent{}, ErrNotFound
	}
	if time.Now().After(p.ExpiresAt) {
		return Agent{}, ErrExpired
	}
	if p.UsedAt != nil {
		return Agent{}, ErrUsed
	}
	now := time.Now().UTC()
	p.UsedAt = &now
	s.pairings[key] = p
	agent := s.agents[p.AgentID]
	agent.OwnerUserID = &userID
	agent.Status = "online"
	agent.LastSeenAt = &now
	s.agents[p.AgentID] = agent
	return agent, nil
}

func (s *MemoryStore) ListAgents(ctx context.Context, userID string) ([]Agent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Agent{}
	for _, agent := range s.agents {
		if agent.OwnerUserID != nil && *agent.OwnerUserID == userID {
			out = append(out, agent)
		}
	}
	return out, nil
}

func (s *MemoryStore) UserCanAccessAgent(ctx context.Context, userID string, agentID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent := s.agents[agentID]
	return agent.OwnerUserID != nil && *agent.OwnerUserID == userID, nil
}
