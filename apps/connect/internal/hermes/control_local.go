package hermes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"

	"github.com/brio/brio/apps/connect/internal/tunnel"
)

func (c *Client) serveControl(
	ctx context.Context,
	frame tunnel.Frame,
	method string,
	route Route,
	emit func(tunnel.Frame) error,
) error {
	wantMethod := http.MethodPost
	if route.Name == "control-events" {
		wantMethod = http.MethodGet
	}
	if method != wantMethod {
		return emit(methodNotAllowed(frame.ID, method, frame.Path))
	}

	var body bytes.Reader
	if frame.Body != nil {
		payload, err := json.Marshal(frame.Body)
		if err != nil {
			return emit(errorFrame(frame.ID, "BAD_REQUEST", err.Error()))
		}
		body = *bytes.NewReader(payload)
	}
	req := httptest.NewRequest(method, frame.Path, &body).WithContext(ctx)
	recorder := httptest.NewRecorder()
	commandCenter := c.commandCenter()
	switch route.Name {
	case "control-rpc":
		commandCenter.controlRPC(recorder, req)
	case "control-command":
		commandCenter.controlCommand(recorder, req)
	case "control-background":
		commandCenter.controlBackground(recorder, req)
	case "control-events":
		commandCenter.controlEvents(recorder, req)
	}

	response := recorder.Result()
	defer response.Body.Close()
	var responseBody any
	if err := json.NewDecoder(response.Body).Decode(&responseBody); err != nil {
		responseBody = map[string]any{"error": "Brio produced an invalid control response"}
	}
	return emit(responseFrame(frame.ID, response.StatusCode, responseBody))
}
