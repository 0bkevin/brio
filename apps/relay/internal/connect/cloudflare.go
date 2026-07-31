package connect

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/brio/brio/apps/relay/internal/store"
)

type CloudflareConfig struct {
	AccountID  string
	APIToken   string
	ZoneID     string
	BaseDomain string
}

type EndpointRuntime struct {
	ProviderKind   string `json:"provider_kind"`
	ConnectorToken string `json:"connector_token"`
	TunnelID       string `json:"tunnel_id,omitempty"`
	TunnelName     string `json:"tunnel_name,omitempty"`
}

type endpointProvisioner struct {
	config CloudflareConfig
	http   *http.Client
	base   string
}

func newEndpointProvisioner(config CloudflareConfig) *endpointProvisioner {
	return &endpointProvisioner{config: config, http: &http.Client{Timeout: 15 * time.Second}, base: "https://api.cloudflare.com/client/v4"}
}

func (p *endpointProvisioner) configured() bool {
	return strings.TrimSpace(p.config.AccountID) != "" && strings.TrimSpace(p.config.APIToken) != "" && strings.TrimSpace(p.config.ZoneID) != "" && strings.TrimSpace(p.config.BaseDomain) != ""
}

func (p *endpointProvisioner) provision(ctx context.Context, userID, environmentID, originHost string, originPort int) (store.ManagedEndpoint, *EndpointRuntime, error) {
	if !p.configured() {
		return store.ManagedEndpoint{}, nil, errors.New("managed endpoint provider is not configured")
	}
	digest := sha256.Sum256([]byte(userID + "\x00" + environmentID))
	suffix := hex.EncodeToString(digest[:])[:20]
	name := "brio-" + suffix
	hostname := name + "." + strings.TrimPrefix(strings.TrimSpace(p.config.BaseDomain), ".")
	tunnelID, err := p.findOrCreateTunnel(ctx, name)
	if err != nil {
		return store.ManagedEndpoint{}, nil, err
	}
	if err := p.configureTunnel(ctx, tunnelID, hostname, originHost, originPort); err != nil {
		return store.ManagedEndpoint{}, nil, err
	}
	if err := p.reconcileDNS(ctx, hostname, tunnelID+".cfargotunnel.com"); err != nil {
		return store.ManagedEndpoint{}, nil, err
	}
	var token string
	if err := p.call(ctx, http.MethodGet, "/accounts/"+url.PathEscape(p.config.AccountID)+"/cfd_tunnel/"+url.PathEscape(tunnelID)+"/token", nil, &token); err != nil {
		return store.ManagedEndpoint{}, nil, err
	}
	if token == "" {
		return store.ManagedEndpoint{}, nil, errors.New("Cloudflare returned an empty connector token")
	}
	return store.ManagedEndpoint{HTTPBaseURL: "https://" + hostname, WSBaseURL: "wss://" + hostname, ProviderKind: "cloudflare_tunnel"}, &EndpointRuntime{ProviderKind: "cloudflare_tunnel", ConnectorToken: token, TunnelID: tunnelID, TunnelName: name}, nil
}

func (p *endpointProvisioner) deprovision(ctx context.Context, userID, environmentID string) error {
	if !p.configured() {
		return errors.New("managed endpoint provider is not configured")
	}
	digest := sha256.Sum256([]byte(userID + "\x00" + environmentID))
	name := "brio-" + hex.EncodeToString(digest[:])[:20]
	hostname := name + "." + strings.TrimPrefix(strings.TrimSpace(p.config.BaseDomain), ".")
	dnsPath := "/zones/" + url.PathEscape(p.config.ZoneID) + "/dns_records"
	var records []struct {
		ID string `json:"id"`
	}
	if err := p.call(ctx, http.MethodGet, dnsPath+"?type=CNAME&name="+url.QueryEscape(hostname), nil, &records); err != nil {
		return err
	}
	for _, record := range records {
		if record.ID != "" {
			if err := p.call(ctx, http.MethodDelete, dnsPath+"/"+url.PathEscape(record.ID), nil, nil); err != nil {
				return err
			}
		}
	}
	var tunnels []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	tunnelPath := "/accounts/" + url.PathEscape(p.config.AccountID) + "/cfd_tunnel"
	if err := p.call(ctx, http.MethodGet, tunnelPath+"?is_deleted=false&name="+url.QueryEscape(name), nil, &tunnels); err != nil {
		return err
	}
	for _, tunnel := range tunnels {
		if tunnel.ID != "" && tunnel.Name == name {
			if err := p.call(ctx, http.MethodDelete, tunnelPath+"/"+url.PathEscape(tunnel.ID), nil, nil); err != nil {
				return err
			}
		}
	}
	return nil
}

func (p *endpointProvisioner) findOrCreateTunnel(ctx context.Context, name string) (string, error) {
	var tunnels []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	path := "/accounts/" + url.PathEscape(p.config.AccountID) + "/cfd_tunnel?is_deleted=false&name=" + url.QueryEscape(name)
	if err := p.call(ctx, http.MethodGet, path, nil, &tunnels); err != nil {
		return "", err
	}
	for _, tunnel := range tunnels {
		if tunnel.Name == name && tunnel.ID != "" {
			return tunnel.ID, nil
		}
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := p.call(ctx, http.MethodPost, "/accounts/"+url.PathEscape(p.config.AccountID)+"/cfd_tunnel", map[string]any{"name": name, "config_src": "cloudflare"}, &created); err != nil {
		return "", err
	}
	if created.ID == "" {
		return "", errors.New("Cloudflare returned an empty tunnel id")
	}
	return created.ID, nil
}

func (p *endpointProvisioner) configureTunnel(ctx context.Context, tunnelID, hostname, originHost string, originPort int) error {
	serviceHost := originHost
	if strings.Contains(serviceHost, ":") {
		serviceHost = "[" + strings.Trim(serviceHost, "[]") + "]"
	}
	path := "/accounts/" + url.PathEscape(p.config.AccountID) + "/cfd_tunnel/" + url.PathEscape(tunnelID) + "/configurations"
	return p.call(ctx, http.MethodPut, path, map[string]any{"config": map[string]any{"ingress": []map[string]any{
		{"hostname": hostname, "service": fmt.Sprintf("http://%s:%d", serviceHost, originPort)},
		{"service": "http_status:404"},
	}}}, nil)
}

func (p *endpointProvisioner) reconcileDNS(ctx context.Context, hostname, target string) error {
	path := "/zones/" + url.PathEscape(p.config.ZoneID) + "/dns_records"
	var records []struct {
		ID string `json:"id"`
	}
	if err := p.call(ctx, http.MethodGet, path+"?type=CNAME&name="+url.QueryEscape(hostname), nil, &records); err != nil {
		return err
	}
	payload := map[string]any{"type": "CNAME", "name": hostname, "content": target, "ttl": 1, "proxied": true}
	if len(records) == 0 {
		return p.call(ctx, http.MethodPost, path, payload, nil)
	}
	return p.call(ctx, http.MethodPut, path+"/"+url.PathEscape(records[0].ID), payload, nil)
}

func (p *endpointProvisioner) call(ctx context.Context, method, path string, body any, output any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	request, err := http.NewRequestWithContext(ctx, method, p.base+path, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+p.config.APIToken)
	request.Header.Set("Content-Type", "application/json")
	response, err := p.http.Do(request)
	if err != nil {
		return fmt.Errorf("Cloudflare request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent {
		return nil
	}
	var envelope struct {
		Success bool            `json:"success"`
		Result  json.RawMessage `json:"result"`
		Errors  []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&envelope); err != nil {
		return fmt.Errorf("decode Cloudflare response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || !envelope.Success {
		message := response.Status
		if len(envelope.Errors) > 0 && envelope.Errors[0].Message != "" {
			message = envelope.Errors[0].Message
		}
		return fmt.Errorf("Cloudflare API rejected %s %s: %s", method, path, message)
	}
	if output != nil && len(envelope.Result) > 0 && string(envelope.Result) != "null" {
		if err := json.Unmarshal(envelope.Result, output); err != nil {
			return fmt.Errorf("decode Cloudflare result: %w", err)
		}
	}
	return nil
}
