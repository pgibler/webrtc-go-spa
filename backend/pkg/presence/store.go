package presence

import (
	"context"
	"fmt"
	"strings"

	"github.com/redis/go-redis/v9"
)

// Store tracks peers connected to a room.
type Store interface {
	Reset(ctx context.Context) error
	AddPeer(ctx context.Context, id string) error
	RemovePeer(ctx context.Context, id string) error
	Peers(ctx context.Context) ([]string, error)
}

// RedisStore implements Store using a Redis set.
type RedisStore struct {
	rdb      *redis.Client
	keyPeers string
}

// NewRedisStore builds a presence store backed by Redis. Prefix is optional (e.g., "webrtc:room:abc123").
func NewRedisStore(rdb *redis.Client, prefix string) *RedisStore {
	p := strings.TrimSuffix(strings.TrimSpace(prefix), ":")
	if p == "" {
		p = "webrtc"
	}
	return &RedisStore{
		rdb:      rdb,
		keyPeers: fmt.Sprintf("%s:peers", p),
	}
}

func (s *RedisStore) Reset(ctx context.Context) error {
	return s.rdb.Del(ctx, s.keyPeers).Err()
}

func (s *RedisStore) AddPeer(ctx context.Context, id string) error {
	return s.rdb.SAdd(ctx, s.keyPeers, id).Err()
}

func (s *RedisStore) RemovePeer(ctx context.Context, id string) error {
	return s.rdb.SRem(ctx, s.keyPeers, id).Err()
}

func (s *RedisStore) Peers(ctx context.Context) ([]string, error) {
	vals, err := s.rdb.SMembers(ctx, s.keyPeers).Result()
	if err != nil {
		return nil, err
	}
	return vals, nil
}
