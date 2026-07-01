package transport

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

type Client struct {
	serverURL    string
	machineID    string
	privateKey   *ecdsa.PrivateKey
	sharedSecret []byte
	conn         *websocket.Conn
	mu           sync.Mutex
	ctx          context.Context
	cancel       context.CancelFunc
	onMessage    func(Message)
	msgCh        chan []byte // For synchronous enrollment
	done         chan struct{}
	doneOnce     sync.Once
}

func NewClient(serverURL, machineID string) *Client {
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{
		serverURL: serverURL,
		machineID: machineID,
		ctx:       ctx,
		cancel:    cancel,
		msgCh:     make(chan []byte, 10),
		done:      make(chan struct{}),
	}
}

// Done is closed when the read loop stops on an error (connection lost).
// Lets main react to a real disconnection.
func (c *Client) Done() <-chan struct{} {
	return c.done
}

func (c *Client) signalDone() {
	c.doneOnce.Do(func() { close(c.done) })
}

func (c *Client) SetKeys(privateKey *ecdsa.PrivateKey, sharedSecret []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.privateKey = privateKey
	c.sharedSecret = sharedSecret
}

// SessionKey returns the AES session key (K, derived by the ECDHE handshake,
// memory only). Used to decrypt incoming action.request. Never persisted or
// logged.
func (c *Client) SessionKey() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sharedSecret
}

func (c *Client) OnMessage(handler func(Message)) {
	c.onMessage = handler
}

// Connect establishes the WebSocket connection
func (c *Client) Connect() error {
	conn, _, err := websocket.Dial(c.ctx, c.serverURL, &websocket.DialOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return fmt.Errorf("failed to connect to %s: %w", c.serverURL, err)
	}
	// Increase the max message size
	conn.SetReadLimit(1024 * 1024) // 1MB
	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()

	log.Printf("[WS] Connected to %s", c.serverURL)
	return nil
}

// ReadLoop reads incoming messages
func (c *Client) ReadLoop() {
	for {
		select {
		case <-c.ctx.Done():
			return
		default:
		}

		_, data, err := c.conn.Read(c.ctx)
		if err != nil {
			log.Printf("[WS] Read error: %v", err)
			c.signalDone()
			return
		}

		// If we're in enrollment mode, send to the channel
		select {
		case c.msgCh <- data:
		default:
		}

		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("[WS] Failed to parse message: %v", err)
			continue
		}

		if c.onMessage != nil {
			c.onMessage(msg)
		}
	}
}

// SendRaw sends a raw message (for enrollment)
func (c *Client) SendRaw(data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return fmt.Errorf("not connected")
	}
	return c.conn.Write(c.ctx, websocket.MessageText, data)
}

// ReceiveRaw waits for a raw message (for enrollment)
func (c *Client) ReceiveRaw(timeout time.Duration) ([]byte, error) {
	select {
	case data := <-c.msgCh:
		return data, nil
	case <-time.After(timeout):
		return nil, fmt.Errorf("receive timeout after %v", timeout)
	case <-c.ctx.Done():
		return nil, fmt.Errorf("context cancelled")
	}
}

// SendSigned sends a signed and encrypted message
func (c *Client) SendSigned(msgType string, requestID string, payloadData interface{}) error {
	c.mu.Lock()
	privateKey := c.privateKey
	sharedSecret := c.sharedSecret
	c.mu.Unlock()

	if privateKey == nil {
		return fmt.Errorf("no private key set")
	}

	// Serialize the payload
	payloadJSON, err := json.Marshal(payloadData)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}

	// Encrypt if we have a shared secret
	var payload string
	if sharedSecret != nil {
		encrypted, err := encryptAES(string(payloadJSON), sharedSecret)
		if err != nil {
			return fmt.Errorf("failed to encrypt payload: %w", err)
		}
		payload = encrypted
	} else {
		payload = string(payloadJSON)
	}

	// Build the message
	nonce := generateNonce()
	timestamp := time.Now().UTC().Format(time.RFC3339)

	sigPayload := fmt.Sprintf("%d:%s:%s:%s:%s:%s:%s",
		ProtocolVersion, msgType, requestID, c.machineID, timestamp, nonce, payload)

	signature, err := signPayload(sigPayload, privateKey)
	if err != nil {
		return fmt.Errorf("failed to sign message: %w", err)
	}

	msg := Message{
		V:         ProtocolVersion,
		Type:      msgType,
		RequestID: requestID,
		MachineID: c.machineID,
		Timestamp: timestamp,
		Nonce:     nonce,
		Payload:   payload,
		Signature: signature,
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	return c.SendRaw(data)
}

// Close closes the connection
func (c *Client) Close() {
	c.cancel()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn != nil {
		c.conn.Close(websocket.StatusNormalClosure, "agent shutting down")
	}
}

// ===================== Local crypto (avoid import cycle with security) =====================

func signPayload(payload string, privateKey *ecdsa.PrivateKey) (string, error) {
	hash := sha256.Sum256([]byte(payload))
	r, s, err := ecdsa.Sign(rand.Reader, privateKey, hash[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	rBytes := r.Bytes()
	sBytes := s.Bytes()
	copy(sig[32-len(rBytes):32], rBytes)
	copy(sig[64-len(sBytes):64], sBytes)
	return base64.StdEncoding.EncodeToString(sig), nil
}

func generateNonce() string {
	b := make([]byte, 32)
	rand.Read(b)
	return fmt.Sprintf("%x", b)
}

func encryptAES(plaintext string, key []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nil, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(nonce) + ":" +
		base64.StdEncoding.EncodeToString(ciphertext), nil
}
