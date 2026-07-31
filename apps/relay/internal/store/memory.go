package store

import (
	"context"
	"strings"
	"sync"
	"time"
)

type MemoryStore struct {
	mu             sync.Mutex
	users          map[string]User
	userByEmail    map[string]string
	userByIdentity map[string]string
	devices        map[string]Device
	deviceToken    map[string]string
	dpopProofs     map[string]time.Time
	agents         map[string]Agent
	agentToken     map[string]string
	pairings       map[string]Pairing
	enrollments    map[string]Enrollment
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		users:          map[string]User{},
		userByEmail:    map[string]string{},
		userByIdentity: map[string]string{},
		devices:        map[string]Device{},
		deviceToken:    map[string]string{},
		dpopProofs:     map[string]time.Time{},
		agents:         map[string]Agent{},
		agentToken:     map[string]string{},
		pairings:       map[string]Pairing{},
		enrollments:    map[string]Enrollment{},
	}
}

func (s *MemoryStore) UpsertIdentity(ctx context.Context, issuer string, subject string, email string) (User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	issuer = strings.TrimRight(strings.TrimSpace(issuer), "/")
	subject = strings.TrimSpace(subject)
	if issuer == "" || subject == "" {
		return User{}, ErrUnauthorized
	}
	key := issuer + "\x00" + subject
	userID := s.userByIdentity[key]
	if userID == "" {
		userID = IdentityUserID(issuer, subject)
		s.users[userID] = User{ID: userID, Email: strings.TrimSpace(email), IdentityIssuer: issuer, IdentitySubject: subject, CreatedAt: time.Now().UTC()}
		s.userByIdentity[key] = userID
	} else if email = strings.TrimSpace(email); email != "" {
		user := s.users[userID]
		user.Email = email
		s.users[userID] = user
	}
	return s.users[userID], nil
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

func (s *MemoryStore) UpsertDevice(ctx context.Context, userID string, deviceID string, name string, proofKeyThumbprint string) (Device, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.users[userID]; !ok {
		return Device{}, ErrUnauthorized
	}
	installationID := strings.TrimSpace(deviceID)
	proofKeyThumbprint = strings.TrimSpace(proofKeyThumbprint)
	if installationID == "" || proofKeyThumbprint == "" {
		return Device{}, ErrUnauthorized
	}
	if name = strings.TrimSpace(name); name == "" {
		name = "Brio mobile"
	}
	deviceID = DeviceRecordID(userID, installationID)
	device, exists := s.devices[deviceID]
	if exists && device.UserID != userID {
		return Device{}, ErrUnauthorized
	}
	if !exists {
		device = Device{ID: deviceID, InstallationID: installationID, UserID: userID, CreatedAt: time.Now().UTC()}
	}
	device.Name = name
	device.ProofKeyThumbprint = proofKeyThumbprint
	device.RevokedAt = nil
	s.devices[deviceID] = device
	return device, nil
}

func (s *MemoryStore) ConsumeDPoPProof(ctx context.Context, thumbprint string, jti string, issuedAt int64, expiresAt time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := thumbprint + "\x00" + jti
	if _, exists := s.dpopProofs[key]; exists {
		return false, nil
	}
	s.dpopProofs[key] = expiresAt
	return true, nil
}

func (s *MemoryStore) PruneDPoPProofs(ctx context.Context, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, expiry := range s.dpopProofs {
		if !expiry.After(now) {
			delete(s.dpopProofs, key)
		}
	}
	return nil
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

func (s *MemoryStore) AuthenticateEnvironment(ctx context.Context, agentID string, credential string) (Agent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent, ok := s.agents[agentID]
	if !ok || credential == "" || agent.EnvironmentCredentialHash != HashSecret(credential) {
		return Agent{}, ErrUnauthorized
	}
	return agent, nil
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
		Code:      RandomCode(16),
		UserID:    userID,
		Name:      name,
		ExpiresAt: now.Add(ttl),
		CreatedAt: now,
	}
	s.enrollments[HashSecret(enrollment.Code)] = enrollment
	return enrollment, nil
}

func (s *MemoryStore) GetEnrollment(ctx context.Context, code string) (Enrollment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	code = strings.ToUpper(strings.TrimSpace(code))
	enrollment, ok := s.enrollments[HashSecret(code)]
	if !ok {
		return Enrollment{}, ErrNotFound
	}
	if time.Now().After(enrollment.ExpiresAt) {
		return Enrollment{}, ErrExpired
	}
	if enrollment.UsedAt != nil {
		return Enrollment{}, ErrUsed
	}
	enrollment.Code = code
	return enrollment, nil
}

func (s *MemoryStore) ClaimEnrollment(ctx context.Context, code string, agentID string, name string, link *ConnectLink) (Agent, string, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := HashSecret(strings.ToUpper(strings.TrimSpace(code)))
	enrollment, ok := s.enrollments[key]
	if !ok {
		return Agent{}, "", "", ErrNotFound
	}
	if time.Now().After(enrollment.ExpiresAt) {
		return Agent{}, "", "", ErrExpired
	}
	if enrollment.UsedAt != nil {
		return Agent{}, "", "", ErrUsed
	}
	if name == "" {
		name = enrollment.Name
	}
	agent := s.agents[agentID]
	if agent.ID != "" && agent.OwnerUserID != nil && *agent.OwnerUserID != enrollment.UserID {
		return Agent{}, "", "", ErrUnauthorized
	}
	now := time.Now().UTC()
	agent.OwnerUserID = &enrollment.UserID
	agent.ID = agentID
	agent.Name = name
	agent.Mode = "self_hosted"
	agent.Status = "online"
	agent.LastSeenAt = &now
	var environmentCredential string
	if link != nil {
		agent.EnvironmentPublicKey = link.EnvironmentPublicKey
		agent.Endpoint = &link.Endpoint
		agent.LinkedAt = &now
		environmentCredential = "brio_env_" + RandomCode(48)
		agent.EnvironmentCredentialHash = HashSecret(environmentCredential)
	}
	if agent.CreatedAt.IsZero() {
		agent.CreatedAt = now
	}
	s.agents[agentID] = agent
	enrollment.UsedAt = &now
	s.enrollments[key] = enrollment
	token := "brio_agent_" + RandomCode(48)
	s.agentToken[agentID] = HashSecret(token)
	return agent, token, environmentCredential, nil
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

func (s *MemoryStore) GetConnectEnvironment(ctx context.Context, userID string, agentID string) (Agent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent, ok := s.agents[agentID]
	if !ok {
		return Agent{}, ErrNotFound
	}
	if agent.OwnerUserID == nil || *agent.OwnerUserID != userID {
		return Agent{}, ErrUnauthorized
	}
	if agent.Endpoint == nil || agent.EnvironmentPublicKey == "" || agent.LinkedAt == nil {
		return Agent{}, ErrNotFound
	}
	return agent, nil
}

func (s *MemoryStore) UnlinkAgent(ctx context.Context, userID string, agentID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent, ok := s.agents[agentID]
	if !ok {
		return false, nil
	}
	if agent.OwnerUserID == nil || *agent.OwnerUserID != userID {
		return false, ErrUnauthorized
	}
	linked := agent.Endpoint != nil || agent.EnvironmentPublicKey != ""
	agent.Endpoint = nil
	agent.LinkedAt = nil
	agent.EnvironmentPublicKey = ""
	agent.EnvironmentCredentialHash = ""
	agent.Status = "offline"
	s.agents[agentID] = agent
	return linked, nil
}

func (s *MemoryStore) UpdateConnectEndpoint(ctx context.Context, agentID string, endpoint ManagedEndpoint) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	agent, ok := s.agents[agentID]
	if !ok || agent.EnvironmentPublicKey == "" {
		return ErrNotFound
	}
	agent.Endpoint = &endpoint
	s.agents[agentID] = agent
	return nil
}

func (s *MemoryStore) CountManagedEndpoints(ctx context.Context, userID string, excludingAgentID string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for _, agent := range s.agents {
		if agent.ID != excludingAgentID && agent.OwnerUserID != nil && *agent.OwnerUserID == userID && agent.Endpoint != nil && agent.Endpoint.ProviderKind == "cloudflare_tunnel" {
			count++
		}
	}
	return count, nil
}
