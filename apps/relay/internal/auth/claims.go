package auth

import "encoding/json"

func claimAs[T any](claims map[string]any, name string) (T, error) {
	var result T
	data, err := json.Marshal(claims[name])
	if err != nil {
		return result, err
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return result, err
	}
	return result, nil
}
