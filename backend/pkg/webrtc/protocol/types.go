package protocol

import "encoding/json"

// ICEServer describes STUN/TURN servers advertised to clients.
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// InboundMessage is the payload clients send to the signaling service.
type InboundMessage struct {
	Type     string          `json:"type"`
	To       string          `json:"to,omitempty"`
	Data     json.RawMessage `json:"data,omitempty"`
	Enabled  *bool           `json:"enabled,omitempty"`
	Username string          `json:"username,omitempty"`
}

// StateMessage is broadcast to clients to convey room state.
type StateMessage struct {
	Type         string            `json:"type"`
	ID           string            `json:"id,omitempty"`
	Peers        []string          `json:"peers,omitempty"`
	Broadcasting []string          `json:"broadcasting,omitempty"`
	Enabled      *bool             `json:"enabled,omitempty"`
	ICEServers   []ICEServer       `json:"iceServers,omitempty"`
	ICEMode      string            `json:"iceMode,omitempty"`
	Usernames    map[string]string `json:"usernames,omitempty"`
}

// SignalMessage carries peer-to-peer WebRTC signaling data.
type SignalMessage struct {
	Type string          `json:"type"`
	From string          `json:"from"`
	To   string          `json:"to"`
	Data json.RawMessage `json:"data"`
}
