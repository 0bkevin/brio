package hermes

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
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
	commandCenter, err := c.commandCenterFor(route.Profile)
	if err != nil {
		return emit(errorFrame(frame.ID, "PROFILE_CONTROL_UNAVAILABLE", err.Error()))
	}

	req := httptest.NewRequest(method, frame.Path, bodyReader(frame.Body)).WithContext(ctx)
	recorder := httptest.NewRecorder()
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
	return emit(recorderFrame(frame.ID, recorder))
}

// bodyReader converts a decoded frame body back into a JSON request body.
func bodyReader(frameBody any) io.Reader {
	if frameBody == nil {
		return http.NoBody
	}
	payload, err := json.Marshal(frameBody)
	if err != nil {
		return http.NoBody
	}
	return bytes.NewReader(payload)
}

// recorderFrame converts one httptest response into a tunnel response frame.
func recorderFrame(id string, recorder *httptest.ResponseRecorder) tunnel.Frame {
	response := recorder.Result()
	defer response.Body.Close()
	var responseBody any
	if err := json.NewDecoder(response.Body).Decode(&responseBody); err != nil {
		responseBody = map[string]any{"error": "Brio produced an invalid local response"}
	}
	return responseFrame(id, response.StatusCode, responseBody)
}
