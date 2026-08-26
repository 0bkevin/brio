package hermes

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/brio/brio/apps/connect/internal/tunnel"
	"nhooyr.io/websocket"
)

const (
	gatewayReadLimit    = 10 * 1024 * 1024
	gatewayWriteTimeout = 15 * time.Second
)

// gatewayChannel is one opaque, full-duplex WebSocket between an authorized
// Mobile tunnel peer and Hermes' native /api/ws endpoint. Brio deliberately
// does not decode JSON-RPC here: Hermes remains the owner of method and event
// semantics, while the relay only multiplexes bounded channel frames.
type gatewayChannel struct {
	conn    *websocket.Conn
	ctx     context.Context
	writeMu sync.Mutex
	once    sync.Once
}

func (c *Client) serveGatewayChannel(ctx context.Context, frame tunnel.Frame, emit func(tunnel.Frame) error) error {
	switch frame.Type {
	case "channel_open":
		return c.openGatewayChannel(ctx, frame, emit)
	case "channel_data":
		return c.writeGatewayChannel(ctx, frame, emit)
	case "channel_close":
		c.closeGatewayChannel(frame.ID, websocket.StatusNormalClosure, "client closed channel")
		return nil
	default:
		return emit(tunnel.Frame{Type: "channel_error", ID: frame.ID, Code: "BAD_CHANNEL_FRAME", Message: "unsupported channel frame"})
	}
}

func (c *Client) openGatewayChannel(ctx context.Context, frame tunnel.Frame, emit func(tunnel.Frame) error) error {
	profile, err := c.gatewayProfile(frame.Path)
	if err != nil {
		return emit(tunnel.Frame{Type: "channel_error", ID: frame.ID, Code: "BAD_CHANNEL_PATH", Message: err.Error()})
	}
	if profile != "" && !c.profileManager().Exists(profile) {
		return emit(tunnel.Frame{Type: "channel_error", ID: frame.ID, Code: "PROFILE_NOT_FOUND", Message: "unknown profile: " + profile})
	}
	endpoint, err := c.gatewayEndpoint(profile)
	if err != nil {
		return emit(tunnel.Frame{Type: "channel_error", ID: frame.ID, Code: "GATEWAY_UNAVAILABLE", Message: err.Error()})
	}
	wsURL, err := controlWebSocketURL(endpoint.BaseURL, endpoint.Token)
	if err != nil {
		return emit(tunnel.Frame{Type: "channel_error", ID: frame.ID, Code: "GATEWAY_UNAVAILABLE", Message: "Hermes gateway configuration is invalid"})
	}

	conn, response, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPClient: c.httpClient()})
	if err != nil {
		code := "GATEWAY_UNAVAILABLE"
		message := "Hermes gateway is unavailable"
		if response != nil && response.StatusCode == http.StatusUnauthorized {
			code = "GATEWAY_UNAUTHORIZED"
			message = "Hermes gateway rejected its configured credential"
		}
		return emit(tunnel.Frame{Type: "channel_error", ID: frame.ID, Code: code, Message: message})
	}
	conn.SetReadLimit(gatewayReadLimit)
	channel := &gatewayChannel{conn: conn, ctx: ctx}

	c.gatewayMu.Lock()
	if c.gatewayChannels == nil {
		c.gatewayChannels = map[string]*gatewayChannel{}
	}
	previous := c.gatewayChannels[frame.ID]
	c.gatewayChannels[frame.ID] = channel
	c.gatewayMu.Unlock()
	if previous != nil {
		previous.close(websocket.StatusGoingAway, "channel resumed")
	}

	if err := emit(tunnel.Frame{Type: "channel_opened", ID: frame.ID, Status: http.StatusSwitchingProtocols}); err != nil {
		c.deleteGatewayChannel(frame.ID, channel)
		channel.close(websocket.StatusInternalError, "relay unavailable")
		return err
	}
	go c.readGatewayChannel(frame.ID, channel, emit)
	return nil
}

func (c *Client) gatewayProfile(path string) (string, error) {
	cleanPath, _, _ := strings.Cut(strings.TrimSpace(path), "?")
	if cleanPath == "/api/ws" {
		return "", nil
	}
	if profile, rest, ok := splitProfilePrefix(cleanPath); ok && rest == "/api/ws" {
		return profile, nil
	}
	return "", errors.New("only /api/ws gateway channels are supported")
}

func (c *Client) gatewayEndpoint(profile string) (ControlEndpoint, error) {
	if profile == "" || profile == DefaultProfileName {
		if strings.TrimSpace(c.ControlBaseURL) == "" || strings.TrimSpace(c.ControlToken) == "" {
			return ControlEndpoint{}, errors.New("Hermes gateway is not configured")
		}
		return ControlEndpoint{BaseURL: c.ControlBaseURL, Token: c.ControlToken}, nil
	}
	endpoint, ok := c.ControlOverrides[profile]
	if !ok || strings.TrimSpace(endpoint.BaseURL) == "" || strings.TrimSpace(endpoint.Token) == "" {
		return ControlEndpoint{}, errors.New("this profile has no dedicated Hermes gateway")
	}
	return endpoint, nil
}

func (c *Client) readGatewayChannel(id string, channel *gatewayChannel, emit func(tunnel.Frame) error) {
	for {
		typ, payload, err := channel.conn.Read(channel.ctx)
		if err != nil {
			c.deleteGatewayChannel(id, channel)
			channel.close(websocket.StatusGoingAway, "gateway channel ended")
			if channel.ctx.Err() == nil {
				status := websocket.CloseStatus(err)
				if status < 0 {
					status = websocket.StatusAbnormalClosure
				}
				_ = emit(tunnel.Frame{Type: "channel_close", ID: id, Status: int(status)})
			}
			return
		}
		if typ != websocket.MessageText {
			c.deleteGatewayChannel(id, channel)
			channel.close(websocket.StatusUnsupportedData, "Hermes gateway sent non-text data")
			_ = emit(tunnel.Frame{Type: "channel_error", ID: id, Code: "UNSUPPORTED_GATEWAY_DATA", Message: "Hermes gateway sent unsupported data"})
			return
		}
		if err := emit(tunnel.Frame{Type: "channel_data", ID: id, Data: string(payload)}); err != nil {
			c.deleteGatewayChannel(id, channel)
			channel.close(websocket.StatusGoingAway, "relay unavailable")
			return
		}
	}
}

func (c *Client) writeGatewayChannel(ctx context.Context, frame tunnel.Frame, emit func(tunnel.Frame) error) error {
	if len(frame.Data) > gatewayReadLimit {
		c.closeGatewayChannel(frame.ID, websocket.StatusMessageTooBig, "message too large")
		return emit(tunnel.Frame{Type: "channel_error", ID: frame.ID, Code: "CHANNEL_DATA_TOO_LARGE", Message: "gateway frame is too large"})
	}
	c.gatewayMu.Lock()
	channel := c.gatewayChannels[frame.ID]
	c.gatewayMu.Unlock()
	if channel == nil {
		return emit(tunnel.Frame{Type: "channel_error", ID: frame.ID, Code: "CHANNEL_NOT_OPEN", Message: "gateway channel is not open"})
	}
	writeCtx, cancel := context.WithTimeout(ctx, gatewayWriteTimeout)
	defer cancel()
	channel.writeMu.Lock()
	err := channel.conn.Write(writeCtx, websocket.MessageText, []byte(frame.Data))
	channel.writeMu.Unlock()
	if err != nil {
		c.deleteGatewayChannel(frame.ID, channel)
		channel.close(websocket.StatusInternalError, "write failed")
		return emit(tunnel.Frame{Type: "channel_error", ID: frame.ID, Code: "GATEWAY_WRITE_FAILED", Message: "could not write to Hermes gateway"})
	}
	return nil
}

func (c *Client) closeGatewayChannel(id string, status websocket.StatusCode, reason string) {
	c.gatewayMu.Lock()
	channel := c.gatewayChannels[id]
	delete(c.gatewayChannels, id)
	c.gatewayMu.Unlock()
	if channel != nil {
		channel.close(status, reason)
	}
}

func (c *Client) deleteGatewayChannel(id string, expected *gatewayChannel) {
	c.gatewayMu.Lock()
	if c.gatewayChannels[id] == expected {
		delete(c.gatewayChannels, id)
	}
	c.gatewayMu.Unlock()
}

func (c *Client) closeGatewayChannels() {
	c.gatewayMu.Lock()
	channels := c.gatewayChannels
	c.gatewayChannels = nil
	c.gatewayMu.Unlock()
	for _, channel := range channels {
		channel.close(websocket.StatusGoingAway, "connector stopped")
	}
}

func (c *gatewayChannel) close(status websocket.StatusCode, reason string) {
	c.once.Do(func() {
		_ = c.conn.Close(status, reason)
	})
}
