package cli

import (
	"testing"

	"github.com/brio/brio/apps/connect/internal/hermes"
)

func TestProfileControlOverridesFromState(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	if overrides := profileControlOverrides(); overrides != nil {
		t.Fatalf("empty state produced overrides %v", overrides)
	}

	v1Hyphen := "HERMES_CONTROL_BASE_" + hermes.ControlEnvSuffix("research-bot")
	v1Underscore := "HERMES_CONTROL_BASE_" + hermes.ControlEnvSuffix("research_bot")
	values := map[string]string{
		stateKeyControlURL:            "http://127.0.0.1:9119",
		"HERMES_CONTROL_BASE_CODER":   "http://127.0.0.1:9211",
		"HERMES_CONTROL_TOKEN_CODER":  "coder-token",
		v1Hyphen:                      "http://127.0.0.1:9311",
		v1Underscore:                  "http://127.0.0.1:9411",
		"HERMES_CONTROL_BASE_DEFAULT": "http://127.0.0.1:9999",
		// Legacy ambiguous raw separator keys are refused, never misrouted.
		"HERMES_CONTROL_BASE_RESEARCH_BOT":  "http://127.0.0.1:9511",
		"HERMES_CONTROL_BASE_RESEARCH_HBOT": "http://127.0.0.1:9521",
	}
	if err := writeState(values); err != nil {
		t.Fatalf("writeState: %v", err)
	}

	overrides := profileControlOverrides()
	if len(overrides) != 3 {
		t.Fatalf("overrides = %+v, want coder + research-bot + research_bot", overrides)
	}
	if coder := overrides["coder"]; coder.BaseURL != "http://127.0.0.1:9211" || coder.Token != "coder-token" {
		t.Fatalf("coder override = %+v (legacy simple-name keys must keep working)", coder)
	}
	if hyphen, ok := overrides["research-bot"]; !ok || hyphen.BaseURL != "http://127.0.0.1:9311" {
		t.Fatalf("research-bot override = %+v", hyphen)
	}
	if underscore, ok := overrides["research_bot"]; !ok || underscore.BaseURL != "http://127.0.0.1:9411" {
		t.Fatalf("research_bot override = %+v", underscore)
	}
	if _, ok := overrides["default"]; ok {
		t.Fatal("default keeps the machine-wide control endpoint")
	}
}
